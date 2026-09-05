'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SUPERVISOR_BASE } from '@/lib/api';

type ReadinessState = 'ready' | 'blocked' | 'unknown';
type SettingsTarget = 'screen-recording' | 'screen-sharing';

interface HostDesktopReadinessResponse {
  screenRecording: ReadinessState;
  screenSharing: ReadinessState;
  ready: boolean;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

interface HostDesktopReadinessProps {
  open: boolean;
}

const initialReadiness: HostDesktopReadinessResponse = {
  screenRecording: 'unknown',
  screenSharing: 'unknown',
  ready: false,
};

export function HostDesktopReadiness({
  open,
}: HostDesktopReadinessProps): React.JSX.Element {
  const [readiness, setReadiness] =
    useState<HostDesktopReadinessResponse>(initialReadiness);
  const [loading, setLoading] = useState(false);
  const [actionTarget, setActionTarget] = useState<SettingsTarget | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(hostDesktopEndpoint('readiness'), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(formatResponseError(response.status, responseText));
      }
      setReadiness(parseReadinessResponse(responseText));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load host desktop permissions',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const openSettings = useCallback(
    async (target: SettingsTarget): Promise<void> => {
      setActionTarget(target);
      setError('');
      try {
        const response = await fetch(hostDesktopEndpoint('open-settings'), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target }),
        });
        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(formatResponseError(response.status, responseText));
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to open macOS System Settings',
        );
      } finally {
        setActionTarget(null);
      }
    },
    [],
  );

  return (
    <section className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">
            Host desktop permissions
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Required for host desktop agents. Docker desktop agents are not
            affected.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Checking...' : 'Recheck'}
        </Button>
      </div>

      <ul aria-label="Host desktop permission status" className="space-y-1">
        <ReadinessRow
          label="Screen Recording"
          status={readiness.screenRecording}
          actionLabel="Open Screen Recording settings"
          actionTarget="screen-recording"
          actionLoading={actionTarget === 'screen-recording'}
          onOpenSettings={openSettings}
        />
        <ReadinessRow
          label="Screen Sharing"
          status={readiness.screenSharing}
          actionLabel="Open Screen Sharing settings"
          actionTarget="screen-sharing"
          actionLoading={actionTarget === 'screen-sharing'}
          onOpenSettings={openSettings}
        />
      </ul>

      {error && (
        <div className="text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

interface ReadinessRowProps {
  label: string;
  status: ReadinessState;
  actionLabel: string;
  actionTarget: SettingsTarget;
  actionLoading: boolean;
  onOpenSettings: (target: SettingsTarget) => Promise<void>;
}

function ReadinessRow({
  label,
  status,
  actionLabel,
  actionTarget,
  actionLoading,
  onOpenSettings,
}: ReadinessRowProps): React.JSX.Element {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ${readinessStatusColor(status)}`}
        />
        <span className="text-sm text-zinc-100">{label}</span>
        <span
          aria-live="polite"
          className={`text-xs ${readinessStatusTextColor(status)}`}
        >
          {readinessStatusLabel(status)}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs text-zinc-400 hover:text-zinc-100"
        onClick={() => void onOpenSettings(actionTarget)}
        disabled={actionLoading}
      >
        {actionLoading ? 'Opening...' : actionLabel}
      </Button>
    </li>
  );
}

function readinessStatusLabel(status: ReadinessState): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Unknown';
  }
}

function readinessStatusColor(status: ReadinessState): string {
  switch (status) {
    case 'ready':
      return 'bg-emerald-400';
    case 'blocked':
      return 'bg-red-400';
    default:
      return 'bg-zinc-500';
  }
}

function readinessStatusTextColor(status: ReadinessState): string {
  switch (status) {
    case 'ready':
      return 'text-emerald-400';
    case 'blocked':
      return 'text-red-400';
    default:
      return 'text-zinc-500';
  }
}

function parseReadinessResponse(value: string): HostDesktopReadinessResponse {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    throw new Error('The host desktop readiness response was invalid');
  }

  const screenRecording = parseReadinessState(parsed.screenRecording);
  const screenSharing = parseReadinessState(parsed.screenSharing);
  if (!screenRecording || !screenSharing || typeof parsed.ready !== 'boolean') {
    throw new Error('The host desktop readiness response was invalid');
  }

  return { screenRecording, screenSharing, ready: parsed.ready };
}

function parseReadinessState(
  value: JsonValue | undefined,
): ReadinessState | null {
  if (value === 'ready' || value === 'blocked' || value === 'unknown') {
    return value;
  }
  return null;
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed: JsonValue = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : null;
  } catch (err) {
    throw new Error('The host desktop readiness response was not valid JSON', {
      cause: err,
    });
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatResponseError(status: number, responseText: string): string {
  const parsed = parseJsonObject(responseText);
  if (parsed) {
    const message = parsed.message ?? parsed.error ?? parsed.code;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return `Request failed with HTTP ${status}`;
}

function hostDesktopEndpoint(endpoint: 'readiness' | 'open-settings'): string {
  return new URL(
    `/api/host-desktop/${endpoint}`,
    `${SUPERVISOR_BASE}/`,
  ).toString();
}
