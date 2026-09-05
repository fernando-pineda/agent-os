'use client';

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

type RfbCredentials = {
  username?: string;
  password?: string;
};

type RfbDisconnectEvent = {
  detail: {
    clean: boolean;
  };
};

type RfbCredentialsRequiredEvent = {
  detail: {
    types: string[];
  };
};

type RfbSecurityFailureEvent = {
  detail: {
    reason?: string;
  };
};

type RfbClient = {
  addEventListener(type: 'connect', listener: () => void): void;
  addEventListener(
    type: 'credentialsrequired',
    listener: (event: RfbCredentialsRequiredEvent) => void,
  ): void;
  addEventListener(
    type: 'disconnect',
    listener: (event: RfbDisconnectEvent) => void,
  ): void;
  addEventListener(
    type: 'securityfailure',
    listener: (event: RfbSecurityFailureEvent) => void,
  ): void;
  disconnect(): void;
  sendCredentials(credentials: RfbCredentials): void;
  scaleViewport: boolean;
  clipViewport: boolean;
};

type RfbConstructor = new (
  target: HTMLElement,
  url: string,
  options?: {
    shared?: boolean;
    wsProtocols?: string[];
  },
) => RfbClient;

const rfbModulePath = '@novnc/novnc';

async function loadRfb(): Promise<RfbConstructor> {
  const module: { default: RfbConstructor } = await import(rfbModulePath);
  return module.default;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type PreviewMetadata = {
  width?: number;
  height?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  scale?: number;
  pixelRatio?: number;
};

type PreviewMessage =
  | { type: 'metadata'; metadata: PreviewMetadata }
  | { type: 'error'; code?: string; message?: string }
  | { type: 'status'; message?: string }
  | { type: 'unknown' };

const previewProtocol = 'host-desktop-preview-v1';
const vncProtocol = 'host-desktop-vnc-v1';

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: JsonObject, key: string): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function getNumber(value: JsonObject, key: string): number | undefined {
  const property = value[key];
  return typeof property === 'number' && Number.isFinite(property)
    ? property
    : undefined;
}

function getObject(value: JsonObject, key: string): JsonObject | undefined {
  const property = value[key];
  return isJsonObject(property) ? property : undefined;
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed: JsonValue = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapPreviewMetadata(value: JsonObject): PreviewMetadata {
  const source = getObject(value, 'metadata') ?? value;
  const width = getNumber(source, 'width');
  const height = getNumber(source, 'height');
  const logicalWidth = getNumber(source, 'logicalWidth');
  const logicalHeight = getNumber(source, 'logicalHeight');
  const scale = getNumber(source, 'scale');
  const pixelRatio = getNumber(source, 'pixelRatio');
  return {
    ...(width !== undefined && width > 0 ? { width } : {}),
    ...(height !== undefined && height > 0 ? { height } : {}),
    ...(logicalWidth !== undefined && logicalWidth > 0 ? { logicalWidth } : {}),
    ...(logicalHeight !== undefined && logicalHeight > 0
      ? { logicalHeight }
      : {}),
    ...(scale !== undefined && scale > 0 ? { scale } : {}),
    ...(pixelRatio !== undefined && pixelRatio > 0 ? { pixelRatio } : {}),
  };
}

function parsePreviewMessage(value: string): PreviewMessage {
  const object = parseJsonObject(value);
  if (!object) return { type: 'unknown' };
  const type = getString(object, 'type');
  if (type === 'metadata') {
    return { type, metadata: mapPreviewMetadata(object) };
  }
  if (type === 'error') {
    return {
      type,
      code: getString(object, 'code'),
      message: getString(object, 'message') ?? getString(object, 'error'),
    };
  }
  if (type === 'status') {
    return { type, message: getString(object, 'message') };
  }
  if (type) {
    return {
      type: 'error',
      code: type,
      message: getString(object, 'message') ?? getString(object, 'error'),
    };
  }
  return { type: 'unknown' };
}

function errorMessage(error: Error | null, fallback: string): string {
  return error?.message || fallback;
}

function hostErrorMessage(code: string | undefined, fallback?: string): string {
  const normalized = code?.toLowerCase().replaceAll('_', '-');
  switch (normalized) {
    case 'service-disabled':
    case 'service-not-running':
    case 'screen-sharing-disabled':
    case 'screen-sharing-service-disabled':
    case 'screen-sharing-unavailable':
      return 'Screen Sharing is disabled. Enable it in macOS System Settings.';
    case 'permission-denied':
    case 'screen-recording-denied':
    case 'screen-recording-permission':
    case 'screen-recording-permission-denied':
      return 'Screen Recording permission is required for the supervisor.';
    case 'grant-required':
    case 'grant-invalid':
    case 'grant-expired':
    case 'invalid-grant':
    case 'missing-grant':
      return 'The host desktop viewer grant was rejected or expired.';
    case 'vnc-auth-failed':
    case 'vnc-auth-failure':
    case 'authentication-failed':
    case 'authentication-failure':
    case 'auth-failed':
      return 'macOS Screen Sharing rejected the VNC credentials.';
    case 'rfb-bridge-failed':
    case 'bridge-failed':
      return 'The host VNC bridge failed to connect.';
    default:
      return fallback ?? 'The host desktop connection failed.';
  }
}

function hostEndpoint(
  baseUrl: string,
  endpoint: 'grant' | 'preview' | 'vnc',
): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(endpoint, base);
}

function webSocketUrl(baseUrl: string, endpoint: 'preview' | 'vnc'): string {
  const url = hostEndpoint(baseUrl, endpoint);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function requestHostGrant(baseUrl: string): Promise<string> {
  const response = await fetch(hostEndpoint(baseUrl, 'grant'), {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  const responseText = await response.text();
  const responseBody = parseJsonObject(responseText);
  if (!response.ok) {
    throw new Error(
      hostErrorMessage(
        responseBody ? getString(responseBody, 'code') : undefined,
        responseBody
          ? (getString(responseBody, 'message') ??
              getString(responseBody, 'error') ??
              `Host desktop grant failed (HTTP ${response.status}).`)
          : `Host desktop grant failed (HTTP ${response.status}).`,
      ),
    );
  }
  if (!responseBody) {
    throw new Error('Host desktop grant returned invalid JSON.');
  }
  const grant =
    getString(responseBody, 'grant') ?? getString(responseBody, 'token');
  if (!grant) {
    throw new Error('Host desktop grant response did not include a grant.');
  }
  return grant;
}

function previewAspectRatio(metadata: PreviewMetadata): string | undefined {
  const width = metadata.logicalWidth ?? metadata.width;
  const height = metadata.logicalHeight ?? metadata.height;
  return width !== undefined && height !== undefined
    ? `${width} / ${height}`
    : undefined;
}

export function HostDesktopPreview({
  baseUrl,
}: {
  baseUrl: string;
}): ReactElement {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<PreviewMetadata>({});
  const [status, setStatus] = useState('Connecting to the shared display...');
  const [error, setError] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;

    const connect = async (): Promise<void> => {
      try {
        const grant = await requestHostGrant(baseUrl);
        if (!active) return;
        socket = new WebSocket(webSocketUrl(baseUrl, 'preview'), [
          previewProtocol,
          grant,
        ]);
        socket.binaryType = 'blob';
        socket.onopen = (): void => {
          if (!active) return;
          setStatus('Waiting for a preview frame...');
          setError(null);
        };
        socket.onmessage = (event: MessageEvent<Blob | string>): void => {
          if (!active) return;
          if (typeof event.data === 'string') {
            const message = parsePreviewMessage(event.data);
            if (message.type === 'metadata') {
              setMetadata(message.metadata);
              return;
            }
            if (message.type === 'error') {
              setError(hostErrorMessage(message.code, message.message));
              return;
            }
            if (message.type === 'status') {
              setStatus(message.message ?? '');
              return;
            }
            setError('Host preview sent an invalid status message.');
            return;
          }
          const nextFrameUrl = URL.createObjectURL(event.data);
          const previousFrameUrl = frameUrlRef.current;
          frameUrlRef.current = nextFrameUrl;
          setFrameUrl(nextFrameUrl);
          if (previousFrameUrl) URL.revokeObjectURL(previousFrameUrl);
          setStatus('');
          setError(null);
        };
        socket.onerror = (): void => {
          if (!active) return;
          setError('The host preview connection failed.');
        };
        socket.onclose = (): void => {
          if (!active) return;
          setStatus('Host preview disconnected.');
        };
      } catch (caughtError) {
        if (!active) return;
        setError(
          errorMessage(
            caughtError instanceof Error ? caughtError : null,
            'Host preview could not start.',
          ),
        );
      }
    };

    void connect();
    return () => {
      active = false;
      socket?.close();
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = null;
    };
  }, [baseUrl]);

  return (
    <div className="relative flex h-32 w-full items-center justify-center bg-zinc-950">
      {frameUrl ? (
        <img
          src={frameUrl}
          alt="Shared macOS desktop preview"
          className="h-full w-full object-contain"
          style={{ aspectRatio: previewAspectRatio(metadata) }}
        />
      ) : (
        <span className="px-2 text-center text-[0.65rem] text-zinc-500">
          {error ?? status}
        </span>
      )}
      {error && frameUrl && (
        <span className="absolute inset-x-1 bottom-1 rounded bg-red-950/90 px-1.5 py-1 text-center text-[0.6rem] text-red-200">
          {error}
        </span>
      )}
    </div>
  );
}

export function HostDesktopView({
  baseUrl,
}: {
  baseUrl: string;
}): ReactElement {
  const targetRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Requesting host desktop access...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    let rfb: RfbClient | null = null;

    const connect = async (): Promise<void> => {
      try {
        const grant = await requestHostGrant(baseUrl);
        if (!active) return;
        setStatus('Connecting to macOS Screen Sharing...');
        const RFB = await loadRfb();
        if (!active) return;
        rfb = new RFB(target, webSocketUrl(baseUrl, 'vnc'), {
          shared: true,
          wsProtocols: [vncProtocol, grant],
        });
        rfb.scaleViewport = true;
        rfb.clipViewport = false;
        rfb.addEventListener('connect', (): void => {
          if (!active) return;
          setStatus('Connected');
          setError(null);
        });
        rfb.addEventListener('credentialsrequired', (event): void => {
          if (!active || !rfb) return;
          const credentials: RfbCredentials = {};
          if (event.detail.types.includes('username')) {
            const username = window.prompt('VNC username');
            if (username === null) {
              setError(
                'VNC credentials are required to open the shared display.',
              );
              rfb.disconnect();
              return;
            }
            credentials.username = username;
          }
          if (event.detail.types.includes('password')) {
            const password = window.prompt('VNC password');
            if (password === null) {
              setError(
                'VNC credentials are required to open the shared display.',
              );
              rfb.disconnect();
              return;
            }
            credentials.password = password;
          }
          rfb.sendCredentials(credentials);
        });
        rfb.addEventListener('securityfailure', (event): void => {
          if (!active) return;
          setError(hostErrorMessage('auth-failed', event.detail.reason));
        });
        rfb.addEventListener('disconnect', (event): void => {
          if (!active) return;
          if (!event.detail.clean) {
            setError('The host VNC connection ended unexpectedly.');
          }
          setStatus('Disconnected');
        });
      } catch (caughtError) {
        if (!active) return;
        setError(
          errorMessage(
            caughtError instanceof Error ? caughtError : null,
            'Host desktop could not start.',
          ),
        );
        setStatus('Unavailable');
      }
    };

    void connect();
    return () => {
      active = false;
      rfb?.disconnect();
    };
  }, [baseUrl]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
      <div className="border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
        This view controls the shared logged-in macOS display. Every host agent
        sees the same screen, and interaction affects the whole Mac.
      </div>
      {error && (
        <div className="border-b border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {!error && status !== 'Connected' && (
        <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">
          {status}
        </div>
      )}
      <div ref={targetRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
