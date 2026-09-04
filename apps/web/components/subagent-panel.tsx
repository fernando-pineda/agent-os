'use client';

import { SquareIcon, XIcon, ChevronRightIcon } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSubagentStreamUrl, stopSubagent } from '@/lib/api';
import type {
  ActiveSubagentRun,
  SubagentJsonObject,
  SubagentJsonValue,
  SubagentSnapshot,
  SubagentStreamEvent,
} from '@/lib/types';

type SubagentStatus = ActiveSubagentRun['status'];

interface SubagentStreamEnvelope {
  runId: string;
  name: string;
  task: string;
  status: SubagentStatus;
  event: SubagentStreamEvent;
}

type ChatEntry =
  | { kind: 'text'; text: string }
  | { kind: 'event'; event: SubagentStreamEvent };

const eventTypes: readonly string[] = [
  'text',
  'tool-call',
  'tool-args',
  'tool-call-end',
  'tool-start',
  'tool-end',
  'done',
  'settled',
];

function isJsonObject(value: SubagentJsonValue): value is SubagentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: SubagentJsonObject, key: string): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function getNumber(value: SubagentJsonObject, key: string): number | undefined {
  const property = value[key];
  return typeof property === 'number' ? property : undefined;
}

function getBoolean(
  value: SubagentJsonObject,
  key: string,
): boolean | undefined {
  const property = value[key];
  return typeof property === 'boolean' ? property : undefined;
}

function isEventType(value: string): value is SubagentStreamEvent['type'] {
  return eventTypes.includes(value);
}

function isStatus(value: string): value is SubagentStatus {
  return value === 'running' || value === 'done' || value === 'stopped';
}

function parseImages(
  value: SubagentJsonValue | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const item of value) {
    if (!isJsonObject(item)) return undefined;
    const data = getString(item, 'data');
    const mimeType = getString(item, 'mimeType');
    if (!data || !mimeType) return undefined;
    images.push({ data, mimeType });
  }
  return images;
}

function parseStreamEvent(
  value: SubagentJsonValue,
  fallbackRunId?: string,
): SubagentStreamEvent | null {
  if (!isJsonObject(value)) return null;
  const runId = getString(value, 'runId') ?? fallbackRunId;
  const type = getString(value, 'type');
  if (!runId || !type || !isEventType(type)) return null;

  const event: SubagentStreamEvent = { runId, type };
  const delta = getString(value, 'delta');
  const toolCallId = getString(value, 'toolCallId');
  const toolName = getString(value, 'toolName');
  const result = getString(value, 'result');
  const args = value.args;
  const images = parseImages(value.images);
  const isError = getBoolean(value, 'isError');

  if (delta !== undefined) event.delta = delta;
  if (toolCallId !== undefined) event.toolCallId = toolCallId;
  if (toolName !== undefined) event.toolName = toolName;
  if (result !== undefined) event.result = result;
  if (isJsonObject(args)) event.args = args;
  if (images !== undefined) event.images = images;
  if (isError !== undefined) event.isError = isError;
  return event;
}

function parseActiveRun(value: SubagentJsonValue): ActiveSubagentRun | null {
  if (!isJsonObject(value)) return null;
  const runId = getString(value, 'runId');
  const name = getString(value, 'name');
  const task = getString(value, 'task');
  const status = getString(value, 'status');
  const startedAt = getNumber(value, 'startedAt');
  const eventValues = value.events;
  if (
    !runId ||
    !name ||
    !task ||
    !status ||
    !isStatus(status) ||
    startedAt === undefined ||
    !Array.isArray(eventValues)
  ) {
    return null;
  }

  const events: SubagentStreamEvent[] = [];
  for (const eventValue of eventValues) {
    const event = parseStreamEvent(eventValue, runId);
    if (!event) return null;
    events.push(event);
  }
  return { runId, name, task, status, startedAt, events };
}

function parseSnapshot(value: SubagentJsonValue): SubagentSnapshot | null {
  if (!isJsonObject(value) || getString(value, 'type') !== 'snapshot') {
    return null;
  }
  const runValues = value.runs;
  if (!Array.isArray(runValues)) return null;
  const runs: ActiveSubagentRun[] = [];
  for (const runValue of runValues) {
    const run = parseActiveRun(runValue);
    if (!run) return null;
    runs.push(run);
  }
  return { type: 'snapshot', runs };
}

function parseEnvelope(
  value: SubagentJsonValue,
): SubagentStreamEnvelope | null {
  if (!isJsonObject(value)) return null;
  const runId = getString(value, 'runId');
  const name = getString(value, 'name');
  const task = getString(value, 'task');
  const status = getString(value, 'status');
  const eventValue = value.event;
  if (!runId || !name || !task || !status || !isStatus(status)) return null;
  const event = parseStreamEvent(eventValue, runId);
  if (!event) return null;
  return { runId, name, task, status, event: { ...event, runId } };
}

function parseSseMessage(
  data: string,
): SubagentSnapshot | SubagentStreamEvent | SubagentStreamEnvelope | null {
  const parsed: SubagentJsonValue = JSON.parse(data);
  return (
    parseSnapshot(parsed) ?? parseStreamEvent(parsed) ?? parseEnvelope(parsed)
  );
}

function appendEvent(
  runs: ActiveSubagentRun[],
  event: SubagentStreamEvent,
  envelope?: SubagentStreamEnvelope,
): ActiveSubagentRun[] {
  let matched = false;
  const nextRuns = runs.map((run) => {
    if (run.runId !== event.runId) return run;
    matched = true;
    const status =
      run.status === 'stopped'
        ? 'stopped'
        : event.type === 'done' || event.type === 'settled'
          ? 'done'
          : (envelope?.status ?? run.status);
    return { ...run, status, events: [...run.events, event] };
  });

  if (matched || !envelope) return nextRuns;
  return [
    ...nextRuns,
    {
      runId: envelope.runId,
      name: envelope.name,
      task: envelope.task,
      status: envelope.status,
      startedAt: Date.now(),
      events: [event],
    },
  ];
}

function buildChatEntries(events: SubagentStreamEvent[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (const event of events) {
    if (event.type === 'text') {
      const last = entries[entries.length - 1];
      if (last?.kind === 'text') {
        last.text += event.delta ?? '';
      } else {
        entries.push({ kind: 'text', text: event.delta ?? '' });
      }
    } else {
      entries.push({ kind: 'event', event });
    }
  }
  return entries;
}

function formatArgs(args: SubagentJsonObject | undefined): string | null {
  if (!args) return null;
  return JSON.stringify(args, null, 2);
}

function statusDotClass(status: SubagentStatus): string {
  switch (status) {
    case 'running':
      return 'bg-amber-400 animate-pulse';
    case 'done':
      return 'bg-emerald-400';
    case 'stopped':
      return 'bg-red-400';
  }
}

function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'done':
      return 'Done';
    case 'stopped':
      return 'Stopped';
  }
}

/**
 * Minimal floating card for a single subagent run.
 * Shows: status dot, name, truncated task, stop button (running only).
 * Click opens the read-only detail dialog.
 */
function MiniRunCard({
  run,
  stopping,
  onOpen,
  onStop,
}: {
  run: ActiveSubagentRun;
  stopping: boolean;
  onOpen: () => void;
  onStop: () => void;
}): ReactNode {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <button
      type="button"
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-900"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${statusDotClass(run.status)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-100">
          {run.name}
        </div>
        <div className="truncate text-[0.65rem] text-zinc-500">{run.task}</div>
      </div>
      {run.status === 'running' ? (
        <span
          role="button"
          tabIndex={0}
          className="shrink-0 rounded p-1 text-red-400 transition-colors hover:bg-red-950/50"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
              event.preventDefault();
              onStop();
            }
          }}
          title="Stop subagent"
          aria-label={`Stop ${run.name}`}
        >
          {stopping ? (
            <span className="text-[0.6rem] text-zinc-500">...</span>
          ) : (
            <SquareIcon className="size-3" />
          )}
        </span>
      ) : (
        <ChevronRightIcon className="size-3 shrink-0 text-zinc-600" />
      )}
    </button>
  );
}

function ToolCallView({ event }: { event: SubagentStreamEvent }): ReactNode {
  const args = formatArgs(event.args);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[0.7rem]">
        <span className="truncate font-mono text-zinc-300">
          {event.toolName ?? 'tool'}
        </span>
        <span className="shrink-0 text-amber-400">running...</span>
      </div>
      {args && (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[0.65rem] text-zinc-500">
          {args}
        </pre>
      )}
    </div>
  );
}

function ToolResultView({ event }: { event: SubagentStreamEvent }): ReactNode {
  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 ${
        event.isError
          ? 'border-red-900/80 bg-red-950/30 text-red-200'
          : 'border-zinc-800 bg-zinc-950 text-zinc-300'
      }`}
    >
      <div className="text-[0.7rem] font-medium">
        {event.isError ? 'Error' : 'Result'}
      </div>
      {event.result && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[0.65rem] leading-4">
          {event.result}
        </pre>
      )}
      {event.images && event.images.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {event.images.map((image, index) => (
            <img
              key={`${event.toolCallId ?? 'image'}-${index}`}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt="Tool output"
              className="max-h-36 max-w-full rounded border border-zinc-800 object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: SubagentStreamEvent }): ReactNode {
  switch (event.type) {
    case 'tool-call':
    case 'tool-start':
      return <ToolCallView event={event} />;
    case 'tool-args':
    case 'tool-call-end': {
      const args = formatArgs(event.args);
      if (!event.delta && !args) return null;
      return (
        <pre className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 whitespace-pre-wrap break-words text-[0.65rem] text-zinc-500">
          {event.delta ?? args}
        </pre>
      );
    }
    case 'tool-end':
      return <ToolResultView event={event} />;
    case 'done':
    case 'settled':
    case 'text':
      return null;
  }
}

/**
 * Read-only detail view shown inside a Dialog when a card is clicked.
 * Uses the same dark theme and layout patterns as the main Thread.
 */
function ReadOnlyRunView({
  run,
  onClose,
}: {
  run: ActiveSubagentRun;
  onClose: () => void;
}): ReactNode {
  const entries = buildChatEntries(run.events);
  const completed = run.status !== 'running';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          {entries.map((entry, index) =>
            entry.kind === 'text' ? (
              <div
                key={`text-${index}`}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm leading-5 whitespace-pre-wrap text-zinc-100"
              >
                {entry.text}
              </div>
            ) : (
              <div key={`${entry.event.type}-${index}`}>
                <EventRow event={entry.event} />
              </div>
            ),
          )}
          {completed && (
            <div className="pt-2 text-center text-[0.7rem] text-zinc-600">
              {statusLabel(run.status)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SubagentPanel({
  agentId,
}: {
  agentId: string | null;
}): ReactNode {
  const [runs, setRuns] = useState<ActiveSubagentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    setRuns([]);
    setSelectedRunId(null);
    setStreamError(null);
    if (!agentId) return;

    const source = new EventSource(getSubagentStreamUrl(agentId));
    source.onmessage = (message: MessageEvent<string>): void => {
      try {
        const parsed = parseSseMessage(message.data);
        if (!parsed) throw new Error('Invalid subagent stream event');
        setStreamError(null);
        if ('type' in parsed && parsed.type === 'snapshot') {
          setRuns(parsed.runs);
          return;
        }
        if ('event' in parsed) {
          setRuns((currentRuns) =>
            appendEvent(currentRuns, parsed.event, parsed),
          );
          return;
        }
        setRuns((currentRuns) => appendEvent(currentRuns, parsed));
      } catch (error) {
        setStreamError(
          error instanceof Error
            ? error.message
            : 'Failed to parse subagent stream event',
        );
      }
    };
    source.onerror = (): void => {
      setStreamError('Subagent stream disconnected. Reconnecting...');
    };

    return () => source.close();
  }, [agentId]);

  const onStop = useCallback(
    async (runId: string): Promise<void> => {
      if (!agentId || stoppingRunId === runId) return;
      setStoppingRunId(runId);
      setStreamError(null);
      try {
        await stopSubagent(agentId, runId);
        setRuns((currentRuns) =>
          currentRuns.map((run) =>
            run.runId === runId ? { ...run, status: 'stopped' } : run,
          ),
        );
      } catch (error) {
        setStreamError(
          error instanceof Error ? error.message : 'Failed to stop subagent',
        );
      } finally {
        setStoppingRunId(null);
      }
    },
    [agentId, stoppingRunId],
  );

  // Auto-clear finished runs after 30s
  useEffect(() => {
    if (runs.length === 0) return;
    const hasFinished = runs.some((r) => r.status !== 'running');
    if (!hasFinished) return;
    const timer = setTimeout(() => {
      setRuns((current) =>
        current.filter((r) => {
          if (r.status === 'running') return true;
          return Date.now() - r.startedAt < 300_000;
        }),
      );
    }, 60_000);
    return () => clearTimeout(timer);
  }, [runs]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  if (runs.length === 0) return null;

  return (
    <>
      {/* Single floating card - top right */}
      <div className="fixed right-4 top-4 z-40 w-56 rounded-lg border border-zinc-800 bg-zinc-950/90 backdrop-blur-sm">
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="text-xs font-medium text-zinc-300">Subagents</div>
        </div>
        {streamError && (
          <div className="border-b border-red-900/50 bg-red-950/30 px-2.5 py-1.5 text-[0.65rem] text-red-300">
            {streamError}
          </div>
        )}
        <div className="flex flex-col gap-px p-1.5">
          {runs.map((run) => (
            <MiniRunCard
              key={run.runId}
              run={run}
              stopping={stoppingRunId === run.runId}
              onOpen={() => setSelectedRunId(run.runId)}
              onStop={() => void onStop(run.runId)}
            />
          ))}
        </div>
      </div>

      {/* Read-only detail dialog */}
      <Dialog
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
      >
        <DialogContent className="flex max-h-[80vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedRun && (
                <>
                  <span
                    className={`size-2.5 rounded-full ${statusDotClass(selectedRun.status)}`}
                  />
                  {selectedRun.name}
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {selectedRun?.task}
            </DialogDescription>
          </DialogHeader>
          {selectedRun && (
            <ReadOnlyRunView
              run={selectedRun}
              onClose={() => setSelectedRunId(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
