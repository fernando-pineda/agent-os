import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

private enum BrokerLimits {
    static let defaultFramesPerSecond: Double = 10
    static let minimumFramesPerSecond: Double = 1
    static let maximumFramesPerSecond: Double = 30
    static let maximumCommandBytes = 1_048_576
    static let stopTimeoutNanoseconds: UInt64 = 2_000_000_000
    static let screenRecordingPreflightFrameKind: UInt8 = 3
}

private final class Diagnostics {
    func emit(_ message: String) {
        FileHandle.standardError.write(Data("HostDesktopBroker: \(message)\n".utf8))
    }
}

private final class FramedOutput {
    private let diagnostics: Diagnostics
    private let queue = DispatchQueue(label: "agent-os.host-desktop-broker.stdout")
    private var closed = false

    init(diagnostics: Diagnostics) {
        self.diagnostics = diagnostics
    }

    func write(kind: UInt8, payload: Data) {
        guard payload.count <= Int(UInt32.max) else {
            diagnostics.emit("error:payload-too-large")
            return
        }

        queue.sync {
            guard !closed else { return }

            let length = UInt32(payload.count)
            var frame = Data(capacity: payload.count + 5)
            frame.append(kind)
            frame.append(UInt8(truncatingIfNeeded: length))
            frame.append(UInt8(truncatingIfNeeded: length >> 8))
            frame.append(UInt8(truncatingIfNeeded: length >> 16))
            frame.append(UInt8(truncatingIfNeeded: length >> 24))
            frame.append(payload)
            FileHandle.standardOutput.write(frame)
        }
    }

    func close() {
        queue.sync {
            closed = true
        }
    }
}

private struct StreamControlCommand: Decodable {
    let action: String?
    let command: String?
    let type: String?
    let display: UInt32?
    let displayId: UInt32?
    let displayID: UInt32?
    let displayIdentifier: UInt32?
    let fps: Double?
}

private struct PreviewMetadata: Encodable {
    let type = "metadata"
    let displayId: UInt32
    let width: Int
    let height: Int
    let logicalWidth: Int
    let logicalHeight: Int
    let pixelWidth: Int
    let pixelHeight: Int
    let scale: Double
    let pixelRatio: Double
    let scaleFactor: Double
}

private struct ScreenRecordingPreflight: Encodable {
    let type = "screen-recording-preflight"
    let status: String
}

private final class InputReader {
    private let diagnostics: Diagnostics
    private let onCommand: (Data) -> Void
    private let onEnd: () -> Void
    private let source: DispatchSourceRead
    private var buffer = Data()
    private var stopped = false

    init(
        diagnostics: Diagnostics,
        onCommand: @escaping (Data) -> Void,
        onEnd: @escaping () -> Void
    ) {
        self.diagnostics = diagnostics
        self.onCommand = onCommand
        self.onEnd = onEnd
        let source = DispatchSource.makeReadSource(
            fileDescriptor: STDIN_FILENO,
            queue: DispatchQueue.global(qos: .userInitiated)
        )
        self.source = source
        source.setEventHandler { [weak self] in
            self?.readAvailable()
        }
    }

    func start() {
        source.resume()
    }

    private func readAvailable() {
        guard !stopped else { return }

        var bytes = [UInt8](repeating: 0, count: 4096)
        let bytesRead = bytes.withUnsafeMutableBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return 0 }
            return Darwin.read(STDIN_FILENO, baseAddress, buffer.count)
        }
        if bytesRead < 0 {
            if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK {
                return
            }
            diagnostics.emit("error:stdin-read-failed")
            stopped = true
            source.cancel()
            onEnd()
            return
        }
        guard bytesRead > 0 else {
            stopped = true
            source.cancel()
            onEnd()
            return
        }

        buffer.append(contentsOf: bytes[0..<bytesRead])
        guard buffer.count <= BrokerLimits.maximumCommandBytes else {
            diagnostics.emit("error:command-too-large")
            buffer.removeAll(keepingCapacity: true)
            return
        }

        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty else { continue }
            onCommand(line)
        }
    }
}

private final class HostDesktopBroker: NSObject, SCStreamOutput, SCStreamDelegate {
    private let diagnostics: Diagnostics
    private let output: FramedOutput
    private let controlQueue = DispatchQueue(label: "agent-os.host-desktop-broker.control")
    private let frameQueue = DispatchQueue(label: "agent-os.host-desktop-broker.frames")
    private let imageContext = CIContext()
    private let decoder = JSONDecoder()
    private var stream: SCStream?
    private var configuration: SCStreamConfiguration?
    private var requestedFramesPerSecond = BrokerLimits.defaultFramesPerSecond
    private var captureGeneration = 0
    private var terminating = false

    init(diagnostics: Diagnostics, output: FramedOutput) {
        self.diagnostics = diagnostics
        self.output = output
    }

    func receive(commandData: Data) {
        controlQueue.async { [weak self] in
            self?.handle(commandData: commandData)
        }
    }

    func requestShutdown() {
        controlQueue.async { [weak self] in
            self?.shutdown()
        }
    }

    private func handle(commandData: Data) {
        guard !terminating else { return }

        let command: StreamControlCommand
        do {
            command = try decoder.decode(StreamControlCommand.self, from: commandData)
        } catch {
            diagnostics.emit("error:invalid-command")
            return
        }

        guard let operation = command.action ?? command.command ?? command.type else {
            diagnostics.emit("error:command-action-required")
            return
        }

        switch operation.lowercased() {
        case "preflight", "screen-recording-preflight":
            preflightScreenRecording()
        case "start":
            guard let displayIdentifier = command.displayIdentifier
                ?? command.displayId
                ?? command.displayID
                ?? command.display else {
                diagnostics.emit("error:display-identifier-required")
                return
            }
            let framesPerSecond = command.fps.map(boundedFramesPerSecond)
                ?? requestedFramesPerSecond
            requestedFramesPerSecond = framesPerSecond
            start(displayIdentifier: displayIdentifier, framesPerSecond: framesPerSecond)
        case "stop":
            captureGeneration &+= 1
            stopCurrentStream()
        case "setfps":
            guard let fps = command.fps else {
                diagnostics.emit("error:fps-required")
                return
            }
            let framesPerSecond = boundedFramesPerSecond(fps)
            requestedFramesPerSecond = framesPerSecond
            updateFramesPerSecond(framesPerSecond)
        default:
            diagnostics.emit("error:unsupported-command")
        }
    }

    private func boundedFramesPerSecond(_ value: Double?) -> Double {
        guard let value, value.isFinite else {
            diagnostics.emit("error:invalid-fps")
            return BrokerLimits.defaultFramesPerSecond
        }
        return min(
            max(value, BrokerLimits.minimumFramesPerSecond),
            BrokerLimits.maximumFramesPerSecond
        )
    }

    private func preflightScreenRecording() {
        let status = CGRequestScreenCaptureAccess() ? "ready" : "blocked"
        let response = ScreenRecordingPreflight(status: status)
        do {
            output.write(
                kind: BrokerLimits.screenRecordingPreflightFrameKind,
                payload: try JSONEncoder().encode(response)
            )
        } catch {
            diagnostics.emit("error:preflight-encoding-failed")
        }
    }

    private func start(displayIdentifier: UInt32, framesPerSecond: Double) {
        captureGeneration &+= 1
        let generation = captureGeneration
        stopCurrentStream()

        guard CGPreflightScreenCaptureAccess() else {
            diagnostics.emit("error:screen-recording-denied")
            return
        }

        SCShareableContent.getExcludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        ) { [weak self] content, error in
            guard let self else { return }
            self.controlQueue.async {
                guard !self.terminating, generation == self.captureGeneration else { return }
                guard error == nil, let content else {
                    self.diagnostics.emit("error:shareable-content-unavailable")
                    return
                }
                guard let display = content.displays.first(where: {
                    $0.displayID == displayIdentifier
                }) else {
                    self.diagnostics.emit("error:display-not-found")
                    return
                }
                self.configureAndStart(
                    display: display,
                    displayIdentifier: displayIdentifier,
                    framesPerSecond: framesPerSecond,
                    generation: generation
                )
            }
        }
    }

    private func configureAndStart(
        display: SCDisplay,
        displayIdentifier: UInt32,
        framesPerSecond: Double,
        generation: Int
    ) {
        let logicalWidth = max(display.width, 1)
        let logicalHeight = max(display.height, 1)
        let pixelWidth = max(CGDisplayPixelsWide(displayIdentifier), 1)
        let pixelHeight = max(CGDisplayPixelsHigh(displayIdentifier), 1)
        let scaleFactor = Double(pixelWidth) / Double(logicalWidth)

        let contentFilter = SCContentFilter(display: display, excludingWindows: [])
        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.width = pixelWidth
        streamConfiguration.height = pixelHeight
        streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfiguration.minimumFrameInterval = CMTime(
            seconds: 1 / framesPerSecond,
            preferredTimescale: 1_000_000
        )
        streamConfiguration.queueDepth = 2
        streamConfiguration.showsCursor = true

        let captureStream = SCStream(
            filter: contentFilter,
            configuration: streamConfiguration,
            delegate: self
        )

        stream = captureStream
        configuration = streamConfiguration

        let metadata = PreviewMetadata(
            displayId: displayIdentifier,
            width: pixelWidth,
            height: pixelHeight,
            logicalWidth: logicalWidth,
            logicalHeight: logicalHeight,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            scale: scaleFactor,
            pixelRatio: scaleFactor,
            scaleFactor: scaleFactor
        )
        do {
            output.write(kind: 1, payload: try JSONEncoder().encode(metadata))
        } catch {
            diagnostics.emit("error:metadata-encoding-failed")
            stream = nil
            configuration = nil
            return
        }

        do {
            try captureStream.addStreamOutput(
                self,
                type: .screen,
                sampleHandlerQueue: frameQueue
            )
        } catch {
            diagnostics.emit("error:stream-output-add-failed")
            stream = nil
            configuration = nil
            return
        }
        captureStream.startCapture { [weak self] error in
            guard let self else { return }
            self.controlQueue.async {
                guard self.stream === captureStream,
                      generation == self.captureGeneration,
                      !self.terminating else { return }
                guard error == nil else {
                    self.diagnostics.emit("error:stream-start-failed")
                    self.stream = nil
                    self.configuration = nil
                    return
                }
            }
        }
    }

    private func updateFramesPerSecond(_ framesPerSecond: Double) {
        guard let stream, let configuration else { return }
        configuration.minimumFrameInterval = CMTime(
            seconds: 1 / framesPerSecond,
            preferredTimescale: 1_000_000
        )
        stream.updateConfiguration(configuration) { [weak self, weak stream] error in
            guard let self else { return }
            self.controlQueue.async {
                guard !self.terminating, self.stream === stream else { return }
                if error != nil {
                    self.diagnostics.emit("error:frame-cadence-update-failed")
                }
            }
        }
    }

    private func stopCurrentStream() {
        guard let currentStream = stream else {
            configuration = nil
            return
        }

        stream = nil
        configuration = nil
        currentStream.stopCapture { [weak self] error in
            if error != nil {
                self?.diagnostics.emit("error:stream-stop-failed")
            }
        }
    }

    private func shutdown() {
        guard !terminating else { return }
        terminating = true
        captureGeneration &+= 1

        guard let currentStream = stream else {
            finishTermination()
            return
        }

        stream = nil
        configuration = nil
        let timeout = DispatchWorkItem { [weak self] in
            self?.finishTermination()
        }
        controlQueue.asyncAfter(
            deadline: .now() + .nanoseconds(Int(BrokerLimits.stopTimeoutNanoseconds)),
            execute: timeout
        )
        currentStream.stopCapture { [weak self] error in
            self?.controlQueue.async {
                if error != nil {
                    self?.diagnostics.emit("error:stream-stop-failed")
                }
                timeout.cancel()
                self?.finishTermination()
            }
        }
    }

    private func finishTermination() {
        output.close()
        exit(EXIT_SUCCESS)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let jpeg = jpegData(pixelBuffer: pixelBuffer) else {
            return
        }
        output.write(kind: 2, payload: jpeg)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        controlQueue.async { [weak self] in
            guard let self, self.stream === stream else { return }
            self.stream = nil
            self.configuration = nil
            self.diagnostics.emit("error:stream-stopped")
        }
    }

    private func jpegData(pixelBuffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = imageContext.createCGImage(image, from: image.extent) else {
            diagnostics.emit("error:frame-encoding-failed")
            return nil
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            diagnostics.emit("error:frame-encoding-failed")
            return nil
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else {
            diagnostics.emit("error:frame-encoding-failed")
            return nil
        }
        return Data(referencing: data)
    }
}

private let diagnostics = Diagnostics()
private let output = FramedOutput(diagnostics: diagnostics)
private let broker = HostDesktopBroker(diagnostics: diagnostics, output: output)
private let inputReader = InputReader(
    diagnostics: diagnostics,
    onCommand: { commandData in
        broker.receive(commandData: commandData)
    },
    onEnd: {
        broker.requestShutdown()
    }
)

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
private let terminationSource = DispatchSource.makeSignalSource(
    signal: SIGTERM,
    queue: DispatchQueue.main
)
terminationSource.setEventHandler {
    broker.requestShutdown()
}
terminationSource.resume()
inputReader.start()
dispatchMain()
