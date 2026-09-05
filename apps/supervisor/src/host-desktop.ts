import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import { readAgentConfig } from './registry.js';

const HOST_GRANT_TTL_MS = 60_000;
const HOST_VNC_PROBE_TIMEOUT_MS = 750;
const HOST_SCREEN_RECORDING_PREFLIGHT_TIMEOUT_MS = 1_000;
const HOST_SETTINGS_OPEN_TIMEOUT_MS = 2_000;
const HOST_SETTINGS_MAX_BODY_BYTES = 4 * 1024;
const MAX_HELPER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BRIDGE_BUFFER_BYTES = 4 * 1024 * 1024;
const BRIDGE_RESUME_BUFFER_BYTES = 512 * 1024;
const PREVIEW_PROTOCOL = 'host-desktop-preview-v1';
const VNC_PROTOCOL = 'host-desktop-vnc-v1';
const JPEG_FRAME_KIND = 2;
const METADATA_FRAME_KIND = 1;
const SCREEN_RECORDING_PREFLIGHT_FRAME_KIND = 3;
const HOST_AGENT_ID_RE = /^[a-z0-9-]{1,64}$/;
const HOST_DESKTOP_HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'HostDesktopBroker',
);
const HOST_DISPLAY_ID = readHostDisplayId();

interface HostGrant {
  agentId: string;
  expiresAt: number;
}

export type HostReadinessStatus = 'ready' | 'blocked' | 'unknown';

export interface HostDesktopReadiness {
  screenRecording: HostReadinessStatus;
  screenSharing: HostReadinessStatus;
  ready: boolean;
}

type HostSettingsTarget = 'screen-recording' | 'screen-sharing';

const hostGrants = new Map<string, HostGrant>();

const configuredOrigin =
  process.env.AGENT_OS_WEB_ORIGIN ?? 'http://localhost:3000';
const parsedOrigin = URL.canParse(configuredOrigin)
  ? new URL(configuredOrigin)
  : null;

export const HOST_DESKTOP_ALLOWED_ORIGIN =
  parsedOrigin !== null && isLocalWebOrigin(parsedOrigin)
    ? parsedOrigin.origin
    : null;

const hostWebSocketServer = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  handleProtocols: (protocols: Set<string>): string | false => {
    if (protocols.has(PREVIEW_PROTOCOL)) return PREVIEW_PROTOCOL;
    if (protocols.has(VNC_PROTOCOL)) return VNC_PROTOCOL;
    return false;
  },
});

const HOST_GRANT_PATH = /^\/api\/agents\/([^/]+)\/desktop\/host\/grant$/;
const HOST_PREVIEW_PATH = /^\/api\/agents\/([^/]+)\/desktop\/host\/preview$/;
const HOST_VNC_PATH = /^\/api\/agents\/([^/]+)\/desktop\/host\/vnc$/;
const HOST_READINESS_PATH = '/api/host-desktop/readiness';
const HOST_SETTINGS_PATH = '/api/host-desktop/open-settings';
const HOST_SETTINGS_URLS: Record<HostSettingsTarget, string> = {
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'screen-sharing':
    'x-apple.systempreferences:com.apple.preference.sharing?Services_ScreenSharing',
};

export function isHostDesktopPath(pathname: string): boolean {
  return (
    isHostDesktopAgentPath(pathname) ||
    pathname === HOST_READINESS_PATH ||
    pathname === HOST_SETTINGS_PATH
  );
}

export function isHostDesktopAgentPath(pathname: string): boolean {
  return /^\/api\/agents\/[^/]+\/desktop\/host(?:\/|$)/.test(pathname);
}

export function isAllowedHostDesktopRequest(req: IncomingMessage): boolean {
  return (
    HOST_DESKTOP_ALLOWED_ORIGIN !== null &&
    isLoopbackAddress(req.socket.remoteAddress) &&
    req.headers.origin === HOST_DESKTOP_ALLOWED_ORIGIN
  );
}

export function setHostDesktopCorsHeaders(res: ServerResponse): void {
  if (HOST_DESKTOP_ALLOWED_ORIGIN === null) return;
  res.setHeader('Access-Control-Allow-Origin', HOST_DESKTOP_ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

export async function handleHostDesktopRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === HOST_READINESS_PATH) {
    if (!isAllowedHostDesktopRequest(req)) {
      sendJson(res, 403, { error: 'Host desktop access is not allowed' });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const readiness = await readHostDesktopReadiness();
    sendJson(res, 200, readiness, { 'Cache-Control': 'no-store' });
    return true;
  }

  if (pathname === HOST_SETTINGS_PATH) {
    if (!isAllowedHostDesktopRequest(req)) {
      sendJson(res, 403, { error: 'Host desktop access is not allowed' });
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const target = await readHostSettingsTarget(req);
    if (target === null) {
      sendJson(res, 400, {
        code: 'invalid-target',
        error: 'target must be screen-recording or screen-sharing',
      });
      return true;
    }
    if (!(await openHostSettings(target))) {
      sendJson(res, 500, {
        code: 'settings-open-failed',
        error: 'Unable to open macOS System Settings',
      });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const grantMatch = HOST_GRANT_PATH.exec(pathname);
  if (grantMatch !== null) {
    if (!isAllowedHostDesktopRequest(req)) {
      sendJson(res, 403, { error: 'Host desktop access is not allowed' });
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const agentId = decodeAgentId(grantMatch[1]);
    if (agentId === null || !(await isHostAgent(agentId))) {
      sendJson(res, 404, { error: 'No host desktop for this agent' });
      return true;
    }
    if (!(await probeHostVnc())) {
      sendJson(res, 503, {
        code: 'service-disabled',
        error:
          'Screen Sharing is disabled. Enable it in macOS System Settings, then try again.',
      });
      return true;
    }
    const issuedAt = Date.now();
    const grant = issueHostGrant(agentId, issuedAt);
    setHostDesktopCorsHeaders(res);
    sendJson(res, 201, {
      grant,
      expiresAt: issuedAt + HOST_GRANT_TTL_MS,
    });
    return true;
  }

  const previewMatch = HOST_PREVIEW_PATH.exec(pathname);
  const vncMatch = HOST_VNC_PATH.exec(pathname);
  if (previewMatch === null && vncMatch === null) return false;
  if (!isAllowedHostDesktopRequest(req)) {
    sendJson(res, 403, { error: 'Host desktop access is not allowed' });
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  res.writeHead(426, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'WebSocket upgrade required' }));
  return true;
}

export async function handleHostDesktopUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<boolean> {
  const requestUrl = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const previewMatch = HOST_PREVIEW_PATH.exec(requestUrl.pathname);
  const vncMatch = HOST_VNC_PATH.exec(requestUrl.pathname);
  if (previewMatch === null && vncMatch === null) return false;
  if (req.method !== 'GET') {
    rejectUpgrade(socket, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAllowedHostDesktopRequest(req)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return true;
  }
  const match = previewMatch !== null ? previewMatch : vncMatch;
  if (match === null) {
    rejectUpgrade(socket, 404, 'Not Found');
    return true;
  }
  const agentId = decodeAgentId(match[1]);
  if (agentId === null || !(await isHostAgent(agentId))) {
    rejectUpgrade(socket, 404, 'Not Found');
    return true;
  }
  const protocol = previewMatch !== null ? PREVIEW_PROTOCOL : VNC_PROTOCOL;
  const protocols = readWebSocketProtocols(req);
  const grant = protocols[1];
  if (
    protocols.length !== 2 ||
    protocols[0] !== protocol ||
    grant === undefined ||
    !hasHostGrant(agentId, grant)
  ) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return true;
  }

  hostWebSocketServer.handleUpgrade(
    req,
    socket,
    head,
    (webSocket: WebSocket): void => {
      if (previewMatch !== null) {
        startPreview(webSocket);
      } else {
        startVnc(webSocket);
      }
    },
  );
  return true;
}

function isLocalWebOrigin(origin: URL): boolean {
  return (
    (origin.protocol === 'http:' || origin.protocol === 'https:') &&
    origin.username === '' &&
    origin.password === '' &&
    origin.pathname === '/' &&
    origin.search === '' &&
    origin.hash === '' &&
    (origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]' ||
      origin.hostname === '::1')
  );
}

function readHostDisplayId(): number {
  const configuredDisplayId = process.env.AGENT_OS_DISPLAY_ID;
  if (configuredDisplayId === undefined) return 1;
  const displayId = Number(configuredDisplayId);
  return Number.isInteger(displayId) &&
    displayId >= 0 &&
    displayId <= 0xffffffff
    ? displayId
    : 1;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (address === '127.0.0.1' || address === '::1') return true;
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length) === '127.0.0.1';
  }
  return false;
}

function decodeAgentId(encodedId: string | undefined): string | null {
  if (encodedId === undefined) return null;
  try {
    const agentId = decodeURIComponent(encodedId);
    return HOST_AGENT_ID_RE.test(agentId) ? agentId : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

async function isHostAgent(agentId: string): Promise<boolean> {
  const config = await readAgentConfig(agentId);
  return config !== null && config.sandboxType !== 'docker-desktop';
}

function issueHostGrant(agentId: string, issuedAt: number): string {
  pruneExpiredGrants(issuedAt);
  let grant = randomBytes(16).toString('hex');
  while (hostGrants.has(grant)) {
    grant = randomBytes(16).toString('hex');
  }
  hostGrants.set(grant, {
    agentId,
    expiresAt: issuedAt + HOST_GRANT_TTL_MS,
  });
  return grant;
}

function hasHostGrant(agentId: string, grant: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(grant)) return false;
  const candidate = Buffer.from(grant, 'hex');
  const now = Date.now();
  let valid = false;
  for (const [storedGrant, record] of hostGrants) {
    if (record.expiresAt <= now) {
      hostGrants.delete(storedGrant);
      continue;
    }
    const storedCandidate = Buffer.from(storedGrant, 'hex');
    const matches = timingSafeEqual(candidate, storedCandidate);
    if (matches) valid = record.agentId === agentId;
  }
  return valid;
}

function pruneExpiredGrants(now: number): void {
  for (const [grant, record] of hostGrants) {
    if (record.expiresAt <= now) hostGrants.delete(grant);
  }
}

function readWebSocketProtocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  const value = Array.isArray(header) ? header.join(',') : header;
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body:
    | { error: string; code?: string }
    | { grant: string; expiresAt: number }
    | HostDesktopReadiness
    | { ok: true },
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readHostDesktopReadiness(): Promise<HostDesktopReadiness> {
  const [screenRecording, screenSharingAvailable] = await Promise.all([
    probeHostScreenRecording(),
    probeHostVnc(),
  ]);
  const screenSharing: HostReadinessStatus = screenSharingAvailable
    ? 'ready'
    : 'blocked';
  return {
    screenRecording,
    screenSharing,
    ready: screenRecording === 'ready' && screenSharing === 'ready',
  };
}

async function readHostSettingsTarget(
  req: IncomingMessage,
): Promise<HostSettingsTarget | null> {
  const bodyText = await readHostSettingsBody(req);
  if (bodyText === null) return null;
  let body: { target?: string } | null;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (body === null) return null;
  if (body.target === 'screen-recording') return body.target;
  if (body.target === 'screen-sharing') return body.target;
  return null;
}

function readHostSettingsBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let oversized = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string): void => {
      if (oversized) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes + chunkBytes > HOST_SETTINGS_MAX_BODY_BYTES) {
        oversized = true;
        return;
      }
      body += chunk;
      bodyBytes += chunkBytes;
    });
    req.on('end', (): void => resolve(oversized ? null : body));
    req.on('error', reject);
  });
}

function openHostSettings(target: HostSettingsTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', [HOST_SETTINGS_URLS[target]], {
      stdio: 'ignore',
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(opened);
    };
    child.once('error', () => finish(false));
    child.once('close', (code: number | null) => finish(code === 0));
    timeout = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM');
      finish(false);
    }, HOST_SETTINGS_OPEN_TIMEOUT_MS);
  });
}

function probeHostScreenRecording(): Promise<HostReadinessStatus> {
  return new Promise((resolve) => {
    const child = spawn(HOST_DESKTOP_HELPER, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    let frameBuffer = Buffer.alloc(0);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: HostReadinessStatus): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      stdin?.destroy();
      stdout?.destroy();
      if (!child.killed) child.kill('SIGTERM');
      resolve(status);
    };

    if (stdin === null || stdout === null) {
      finish('unknown');
      return;
    }

    const consumeFrames = (chunk: Buffer | string): void => {
      if (settled) return;
      frameBuffer = Buffer.concat([
        frameBuffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (frameBuffer.length >= 5) {
        const kind = frameBuffer.readUInt8(0);
        const length = frameBuffer.readUInt32LE(1);
        if (length > MAX_HELPER_FRAME_BYTES) {
          finish('unknown');
          return;
        }
        const frameEnd = 5 + length;
        if (frameBuffer.length < frameEnd) return;
        const payload = frameBuffer.subarray(5, frameEnd);
        frameBuffer = frameBuffer.subarray(frameEnd);
        if (kind !== SCREEN_RECORDING_PREFLIGHT_FRAME_KIND) {
          finish('unknown');
          return;
        }
        finish(parseScreenRecordingPreflight(payload) ?? 'unknown');
        return;
      }
    };

    stdout.on('data', consumeFrames);
    stdout.once('error', () => finish('unknown'));
    stdin.once('error', () => finish('unknown'));
    child.once('error', () => finish('unknown'));
    child.once('close', () => finish('unknown'));
    timeout = setTimeout(
      () => finish('unknown'),
      HOST_SCREEN_RECORDING_PREFLIGHT_TIMEOUT_MS,
    );
    stdin.end('{"action":"preflight"}\n');
  });
}

function parseScreenRecordingPreflight(
  payload: Buffer,
): HostReadinessStatus | null {
  let value: { type?: string; status?: string } | null;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (value === null || value.type !== 'screen-recording-preflight') {
    return null;
  }
  if (value.status === 'ready' || value.status === 'blocked') {
    return value.status;
  }
  return null;
}

function probeHostVnc(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 5900 });
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(HOST_VNC_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function startPreview(webSocket: WebSocket): void {
  const child = spawn(HOST_DESKTOP_HELPER, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill('SIGTERM');
    webSocket.close(1011, 'Host desktop helper unavailable');
    return;
  }

  let stopped = false;
  let frameBuffer = Buffer.alloc(0);
  let diagnosticBuffer = '';

  const sendText = (text: string): void => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(text, (error?: Error): void => {
      if (error !== undefined) stop(1011, 'Host desktop stream failed');
    });
  };

  const sendBinary = (data: Buffer): void => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(data, (error?: Error): void => {
      if (error !== undefined) stop(1011, 'Host desktop stream failed');
    });
  };

  const stop = (code: number, reason: string, status?: string): void => {
    if (stopped) return;
    if (status !== undefined) {
      sendText(JSON.stringify({ type: 'error', message: status }));
    }
    stopped = true;
    if (!stdin.destroyed && !stdin.writableEnded) {
      stdin.end('{"action":"stop"}\n');
    }
    stdout.destroy();
    stderr.destroy();
    if (!child.killed) child.kill('SIGTERM');
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.close(code, reason);
    }
  };

  const fail = (message: string): void => {
    stop(1011, 'Host desktop stream failed', message);
  };

  const consumeFrames = (chunk: Buffer | string): void => {
    if (stopped) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    frameBuffer = Buffer.concat([frameBuffer, bytes]);
    while (frameBuffer.length >= 5) {
      const kind = frameBuffer.readUInt8(0);
      const length = frameBuffer.readUInt32LE(1);
      if (length > MAX_HELPER_FRAME_BYTES) {
        fail('Host desktop helper frame is too large');
        return;
      }
      const frameEnd = 5 + length;
      if (frameBuffer.length < frameEnd) return;
      const payload = frameBuffer.subarray(5, frameEnd);
      frameBuffer = frameBuffer.subarray(frameEnd);
      if (kind === JPEG_FRAME_KIND) {
        sendBinary(payload);
      } else if (kind === METADATA_FRAME_KIND) {
        sendText(payload.toString('utf8'));
      } else {
        fail('Host desktop helper frame kind is invalid');
        return;
      }
    }
  };

  const consumeDiagnostics = (chunk: Buffer | string): void => {
    if (stopped) return;
    diagnosticBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    while (diagnosticBuffer.includes('\n')) {
      const newline = diagnosticBuffer.indexOf('\n');
      const line = diagnosticBuffer.slice(0, newline).trim();
      diagnosticBuffer = diagnosticBuffer.slice(newline + 1);
      const match = /error:([a-z0-9-]+)/.exec(line);
      const code = match?.[1];
      if (code !== undefined) {
        sendText(
          JSON.stringify({
            type: 'error',
            code,
            message: `Host desktop helper reported ${code}`,
          }),
        );
      }
    }
  };

  webSocket.on('message', (): void => {
    stop(1008, 'Preview messages are not accepted');
  });
  webSocket.on('error', (): void => {
    stop(1011, 'Host desktop stream failed');
  });
  webSocket.on('close', (): void => {
    stop(1000, 'Host desktop stream closed');
  });
  stdin.on('error', (): void => {
    fail('Host desktop helper input failed');
  });
  stdout.on('data', consumeFrames);
  stdout.on('error', (): void => {
    fail('Host desktop helper output failed');
  });
  stderr.on('data', consumeDiagnostics);
  stderr.on('error', (): void => {
    fail('Host desktop helper diagnostics failed');
  });
  child.on('error', (): void => {
    fail('Host desktop helper could not start');
  });
  child.on('close', (code: number | null): void => {
    if (stopped) return;
    if (code === 0) {
      stop(1000, 'Host desktop stream ended');
    } else {
      fail('Host desktop helper stopped');
    }
  });
  stdin.write(
    `${JSON.stringify({ action: 'start', displayId: HOST_DISPLAY_ID })}\n`,
  );
}

function startVnc(webSocket: WebSocket): void {
  const tcpSocket = createConnection({ host: '127.0.0.1', port: 5900 });
  const clientToServer: Buffer[] = [];
  const serverToClient: Buffer[] = [];
  let clientToServerBytes = 0;
  let serverToClientBytes = 0;
  let connected = false;
  let stopped = false;
  let tcpBackpressured = false;
  const flushTimer = setInterval(() => flushToClient(), 25);
  flushTimer.unref();

  const stop = (code: number, reason: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(flushTimer);
    tcpSocket.destroy();
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.close(code, reason);
    }
  };

  const flushToServer = (): void => {
    if (stopped) return;
    if (!connected || !tcpSocket.writable) {
      webSocket.pause();
      return;
    }
    while (clientToServer.length > 0) {
      const chunk = clientToServer.shift();
      if (chunk === undefined) return;
      clientToServerBytes -= chunk.length;
      if (!tcpSocket.write(chunk)) {
        tcpBackpressured = true;
        webSocket.pause();
        return;
      }
    }
    if (tcpBackpressured || webSocket.isPaused) {
      tcpBackpressured = false;
      webSocket.resume();
    }
  };

  const flushToClient = (): void => {
    if (stopped || webSocket.readyState !== WebSocket.OPEN) return;
    if (webSocket.bufferedAmount > MAX_BRIDGE_BUFFER_BYTES) {
      tcpSocket.pause();
      return;
    }
    while (
      serverToClient.length > 0 &&
      webSocket.bufferedAmount <= MAX_BRIDGE_BUFFER_BYTES
    ) {
      const chunk = serverToClient.shift();
      if (chunk === undefined) return;
      serverToClientBytes -= chunk.length;
      webSocket.send(chunk, (error?: Error): void => {
        if (error !== undefined) stop(1011, 'Host VNC bridge failed');
      });
    }
    if (
      tcpSocket.isPaused() &&
      webSocket.bufferedAmount <= BRIDGE_RESUME_BUFFER_BYTES
    ) {
      tcpSocket.resume();
    }
  };

  webSocket.on('message', (data: RawData, isBinary: boolean): void => {
    if (!isBinary) {
      stop(1003, 'Only binary RFB messages are accepted');
      return;
    }
    const chunk = rawDataToBuffer(data);
    if (clientToServerBytes + chunk.length > MAX_BRIDGE_BUFFER_BYTES) {
      stop(1009, 'Host VNC bridge buffer is full');
      return;
    }
    clientToServer.push(chunk);
    clientToServerBytes += chunk.length;
    flushToServer();
  });
  webSocket.on('error', (): void => {
    stop(1011, 'Host VNC bridge failed');
  });
  webSocket.on('close', (): void => {
    stop(1000, 'Host VNC bridge closed');
  });
  tcpSocket.on('connect', (): void => {
    connected = true;
    tcpSocket.setNoDelay(true);
    flushToServer();
  });
  tcpSocket.on('data', (data: Buffer): void => {
    if (stopped) return;
    if (serverToClientBytes + data.length > MAX_BRIDGE_BUFFER_BYTES) {
      stop(1009, 'Host VNC bridge buffer is full');
      return;
    }
    serverToClient.push(data);
    serverToClientBytes += data.length;
    flushToClient();
  });
  tcpSocket.on('drain', flushToServer);
  tcpSocket.on('error', (): void => {
    stop(1011, 'Host VNC service is unavailable');
  });
  tcpSocket.on('close', (): void => {
    connected = false;
    stop(1011, 'Host VNC service closed');
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}
