'use client';

import {
  Loader2Icon,
  Maximize2Icon,
  SquareIcon,
  XIcon,
  ChevronRightIcon,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
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
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'event'; event: SubagentStreamEvent };

const eventTypes: readonly string[] = [
  'text',
  'tool-call',
  'tool-args',
  'tool-call-end',
  'tool-start',
  'tool-end',
  'usage',
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
  const inputTokens = getNumber(value, 'inputTokens');
  const outputTokens = getNumber(value, 'outputTokens');
  const model = getString(value, 'model');

  if (delta !== undefined) event.delta = delta;
  if (toolCallId !== undefined) event.toolCallId = toolCallId;
  if (toolName !== undefined) event.toolName = toolName;
  if (result !== undefined) event.result = result;
  if (isJsonObject(args)) event.args = args;
  if (images !== undefined) event.images = images;
  if (isError !== undefined) event.isError = isError;
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  if (model !== undefined) event.model = model;
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

  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;
  const events: SubagentStreamEvent[] = [];
  for (const eventValue of eventValues) {
    const event = parseStreamEvent(eventValue, runId);
    if (!event) return null;
    if (event.type === 'usage') {
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
      if (event.model) model = event.model;
    }
    events.push(event);
  }
  return {
    runId,
    name,
    task,
    status,
    startedAt,
    events,
    model,
    inputTokens,
    outputTokens,
  };
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
    const inputTokens =
      run.inputTokens + (event.type === 'usage' ? (event.inputTokens ?? 0) : 0);
    const outputTokens =
      run.outputTokens +
      (event.type === 'usage' ? (event.outputTokens ?? 0) : 0);
    const model =
      event.type === 'usage' && event.model ? event.model : run.model;
    return {
      ...run,
      status,
      events: [...run.events, event],
      inputTokens,
      outputTokens,
      model,
    };
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
      model: event.type === 'usage' ? event.model : undefined,
      inputTokens: event.type === 'usage' ? (event.inputTokens ?? 0) : 0,
      outputTokens: event.type === 'usage' ? (event.outputTokens ?? 0) : 0,
    },
  ];
}

function buildChatEntries(
  task: string,
  events: SubagentStreamEvent[],
): ChatEntry[] {
  const entries: ChatEntry[] = [{ kind: 'user', text: task }];
  for (const event of events) {
    if (event.type === 'text') {
      const last = entries[entries.length - 1];
      if (last?.kind === 'text') {
        last.text += event.delta ?? '';
      } else {
        entries.push({ kind: 'text', text: event.delta ?? '' });
      }
    } else if (event.type !== 'usage') {
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
    case 'usage':
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
  const entries = buildChatEntries(run.task, run.events);
  const completed = run.status !== 'running';
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          {entries.map((entry, index) => {
            if (entry.kind === 'user') {
              return (
                <div
                  key={`user-${index}`}
                  className="ml-auto max-w-[85%] rounded-lg bg-zinc-700 px-3 py-2 text-sm leading-5 whitespace-pre-wrap text-zinc-100"
                >
                  {entry.text}
                </div>
              );
            }
            if (entry.kind === 'text') {
              return (
                <div
                  key={`text-${index}`}
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-sm leading-5 whitespace-pre-wrap text-zinc-100"
                >
                  {entry.text}
                </div>
              );
            }
            return (
              <div key={`${entry.event.type}-${index}`}>
                <EventRow event={entry.event} />
              </div>
            );
          })}
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
  desktopUrl,
  desktopPort,
}: {
  agentId: string | null;
  desktopUrl?: string;
  desktopPort?: number;
}): ReactNode {
  const [runs, setRuns] = useState<ActiveSubagentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [desktopExpanded, setDesktopExpanded] = useState(false);

  const resolvedDesktopUrl =
    desktopUrl ??
    (desktopPort !== undefined
      ? `https://localhost:${desktopPort}`
      : undefined);

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

  // Purge strategy: keep max 5 finished runs, purge oldest beyond that.
  // Also purge any finished run after 30s.
  useEffect(() => {
    if (runs.length === 0) return;
    const finished = runs.filter((r) => r.status !== 'running');
    if (finished.length === 0) return;

    const timer = setTimeout(() => {
      setRuns((current) => {
        const now = Date.now();
        // Purge finished runs older than 30s
        let kept = current.filter((r) => {
          if (r.status === 'running') return true;
          return now - r.startedAt < 30_000;
        });
        // If still more than 5 finished, keep only the 5 newest
        const stillFinished = kept.filter((r) => r.status !== 'running');
        if (stillFinished.length > 5) {
          const toRemove = new Set(
            stillFinished
              .sort((a, b) => b.startedAt - a.startedAt)
              .slice(5)
              .map((r) => r.runId),
          );
          kept = kept.filter((r) => !toRemove.has(r.runId));
        }
        return kept;
      });
    }, 5_000);

    return () => clearTimeout(timer);
  }, [runs]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  if (runs.length === 0 && !resolvedDesktopUrl) {
    return (
      <aside className="hidden w-56 flex-shrink-0 py-2 md:flex md:flex-col">
        <div className="mx-2 rounded-lg border border-zinc-800">
          <div className="border-b border-zinc-800 px-3 py-2">
            <div className="text-xs font-medium text-zinc-300">Subagents</div>
          </div>
          <div className="px-3 py-4 text-center text-[0.65rem] text-zinc-600">
            No active subagents
          </div>
        </div>
      </aside>
    );
  }

  return (
    <>
      <aside className="hidden w-56 flex-shrink-0 py-2 md:flex md:flex-col">
        {resolvedDesktopUrl && (
          <div className="mx-2 mb-2 overflow-hidden rounded-lg border border-zinc-800">
            <button
              type="button"
              onClick={() => setDesktopExpanded(true)}
              className="group relative block w-full"
            >
              <iframe
                src={resolvedDesktopUrl}
                title="Desktop preview"
                className="pointer-events-none h-32 w-full border-0"
                scrolling="no"
                tabIndex={-1}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2Icon className="size-5 text-zinc-200" />
              </div>
            </button>
          </div>
        )}
        {runs.length > 0 && (
          <div className="mx-2 rounded-lg border border-zinc-800">
            <div className="border-b border-zinc-800 px-3 py-2">
              <div className="text-xs font-medium text-zinc-300">Subagents</div>
            </div>
            {streamError && (
              <div className="border-b border-red-900/50 px-2.5 py-1.5 text-[0.65rem] text-red-300">
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
        )}
      </aside>

      {desktopExpanded && resolvedDesktopUrl && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2">
            <span className="text-xs font-medium text-zinc-300">Desktop</span>
            <div className="flex items-center gap-2">
              <a
                href={resolvedDesktopUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[0.7rem] text-zinc-400 underline underline-offset-2 hover:text-zinc-100"
              >
                Open in new tab
              </a>
              <button
                type="button"
                onClick={() => setDesktopExpanded(false)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <XIcon className="size-4" />
              </button>
            </div>
          </div>
          <iframe
            src={resolvedDesktopUrl}
            title="Agent desktop"
            className="h-full min-h-0 w-full flex-1 border-0"
            allow="autoplay; clipboard-read; clipboard-write; microphone; camera; fullscreen"
            allowFullScreen
          />
        </div>
      )}

      {/* Read-only detail drawer */}
      <Drawer
        open={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
        swipeDirection="right"
      >
        <DrawerContent className="max-w-md">
          <DrawerHeader className="flex-row items-center justify-between gap-2">
            <div className="flex flex-row items-center gap-2">
              {selectedRun && (
                <>
                  <span
                    className={`size-2.5 rounded-full ${statusDotClass(selectedRun.status)}`}
                  />
                  <DrawerTitle>{selectedRun.name}</DrawerTitle>
                </>
              )}
            </div>
            <button
              type="button"
              className="text-zinc-400 hover:text-zinc-100"
              onClick={() => setSelectedRunId(null)}
            >
              <XIcon className="size-4" />
            </button>
          </DrawerHeader>
          {selectedRun && (
            <>
              <div className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 text-[0.7rem] text-zinc-500">
                {selectedRun.model && (
                  <span className="truncate font-mono">
                    {selectedRun.model}
                  </span>
                )}
                <span className="shrink-0">
                  {(selectedRun.inputTokens / 1000).toFixed(1)}k in
                </span>
                <span className="shrink-0">
                  {(selectedRun.outputTokens / 1000).toFixed(1)}k out
                </span>
              </div>
              <ReadOnlyRunView
                run={selectedRun}
                onClose={() => setSelectedRunId(null)}
              />
            </>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}
