'use client';

import { SquareIcon, XIcon } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
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

function RunCard({
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
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
      onClick={onOpen}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <span
              className={`size-2 shrink-0 rounded-full ${statusDotClass(run.status)}`}
            />
            <span className="truncate">{run.name}</span>
          </div>
          <div className="mt-1 truncate text-xs text-zinc-500">{run.task}</div>
        </div>
        {run.status === 'running' && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-red-400 hover:bg-red-950/50 hover:text-red-300"
            onClick={(event) => {
              event.stopPropagation();
              onStop();
            }}
            disabled={stopping}
            title="Stop subagent"
            aria-label={`Stop ${run.name}`}
          >
            <SquareIcon />
          </Button>
        )}
      </div>
      <div className="mt-2 text-[0.7rem] text-zinc-600">
        {statusLabel(run.status)}
      </div>
    </div>
  );
}

function ToolCallEvent({ event }: { event: SubagentStreamEvent }): ReactNode {
  const args = formatArgs(event.args);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-mono text-zinc-300">
          {event.toolName ?? 'Tool call'}
        </span>
        <span className="shrink-0 text-amber-400">running...</span>
      </div>
      {args && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[0.7rem] text-zinc-500">
          {args}
        </pre>
      )}
    </div>
  );
}

function ToolResultEvent({ event }: { event: SubagentStreamEvent }): ReactNode {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        event.isError
          ? 'border-red-900/80 bg-red-950/30 text-red-200'
          : 'border-zinc-800 bg-zinc-950 text-zinc-300'
      }`}
    >
      <div className="text-xs font-medium">
        {event.isError ? 'Tool error' : 'Tool result'}
      </div>
      {event.result && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[0.7rem] leading-5">
          {event.result}
        </pre>
      )}
      {event.images && event.images.length > 0 && (
        <div className="mt-2 space-y-2">
          {event.images.map((image, index) => (
            <img
              key={`${event.toolCallId ?? 'image'}-${index}`}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt="Tool output"
              className="max-h-48 max-w-full rounded border border-zinc-800 object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventEntry({ event }: { event: SubagentStreamEvent }): ReactNode {
  switch (event.type) {
    case 'tool-call':
    case 'tool-start':
      return <ToolCallEvent event={event} />;
    case 'tool-args':
    case 'tool-call-end': {
      const args = formatArgs(event.args);
      if (!event.delta && !args) return null;
      return (
        <pre className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 whitespace-pre-wrap break-words text-[0.7rem] text-zinc-500">
          {event.delta ?? args}
        </pre>
      );
    }
    case 'tool-end':
      return <ToolResultEvent event={event} />;
    case 'done':
    case 'settled':
      return null;
    case 'text':
      return null;
  }
}

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
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={onClose}
          title="Close subagent view"
          aria-label="Close subagent view"
        >
          <XIcon />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">
            {run.name}
          </div>
          <div className="truncate text-xs text-zinc-500">{run.task}</div>
        </div>
      </div>
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
                <EventEntry event={entry.event} />
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

  if (runs.length === 0) return null;

  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  return (
    <aside className="hidden h-full w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-900 text-zinc-100 md:flex">
      {selectedRun ? (
        <ReadOnlyRunView
          run={selectedRun}
          onClose={() => setSelectedRunId(null)}
        />
      ) : (
        <>
          <div className="border-b border-zinc-800 px-3 py-2">
            <div className="text-xs font-medium text-zinc-400">Subagents</div>
            {streamError && (
              <div className="mt-1 text-[0.7rem] text-red-400">
                {streamError}
              </div>
            )}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {runs.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                stopping={stoppingRunId === run.runId}
                onOpen={() => setSelectedRunId(run.runId)}
                onStop={() => void onStop(run.runId)}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
