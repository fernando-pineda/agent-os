import type {
  AgentSessionEvent,
  AgentToolResult,
} from '@earendil-works/pi-coding-agent';

type ToolResultContent = AgentToolResult<never>['content'];
type TextContent = Extract<ToolResultContent[number], { type: 'text' }>;
type ImageContent = Extract<ToolResultContent[number], { type: 'image' }>;

export interface SubagentStreamEvent {
  runId: string;
  type:
    | 'text'
    | 'tool-call'
    | 'tool-args'
    | 'tool-call-end'
    | 'tool-start'
    | 'tool-end'
    | 'done'
    | 'settled';
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  images?: Array<{ data: string; mimeType: string }>;
  isError?: boolean;
}

export interface ActiveRun {
  runId: string;
  name: string;
  task: string;
  status: 'running' | 'done' | 'stopped';
  startedAt: number;
  events: SubagentStreamEvent[];
}

export interface SubagentListener {
  onEvent: (event: SubagentStreamEvent) => void;
  onSnapshot: (runs: ActiveRun[]) => void;
}

type RunAborter = () => Promise<void>;

const activeRuns = new Map<string, ActiveRun>();
const listeners = new Set<SubagentListener>();
const runAborters = new Map<string, RunAborter>();

function notifyListeners(event: SubagentStreamEvent): void {
  for (const listener of listeners) {
    try {
      listener.onEvent(event);
    } catch (error) {
      console.error(
        `Failed to notify subagent listener: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function abortRun(abort: RunAborter): void {
  void Promise.resolve()
    .then(() => abort())
    .catch((error) => {
      console.error(
        `Failed to abort subagent session: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

export function startRun(runId: string, name: string, task: string): void {
  activeRuns.set(runId, {
    runId,
    name,
    task,
    status: 'running',
    startedAt: Date.now(),
    events: [],
  });
  runAborters.delete(runId);
}

export function registerRunAbort(runId: string, abort: RunAborter): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  if (run.status === 'stopped') {
    abortRun(abort);
    return;
  }
  if (run.status === 'done') return;
  runAborters.set(runId, abort);
}

export function unregisterRunAbort(runId: string): void {
  runAborters.delete(runId);
}

export function stopRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (run?.status !== 'running') return;
  run.status = 'stopped';
  const abort = runAborters.get(runId);
  runAborters.delete(runId);
  if (abort) abortRun(abort);
}

export function notifyRunDone(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run || run.status === 'stopped') return;
  run.status = 'done';
  runAborters.delete(runId);
  storeEvent(runId, { runId, type: 'done' });
  storeEvent(runId, { runId, type: 'settled' });
}

export function getActiveRuns(): ActiveRun[] {
  return Array.from(activeRuns.values(), (run) => ({
    ...run,
    events: [...run.events],
  }));
}

export function subscribe(listener: SubagentListener): () => void {
  listeners.add(listener);
  try {
    listener.onSnapshot(getActiveRuns());
  } catch (error) {
    listeners.delete(listener);
    throw error;
  }
  return () => {
    listeners.delete(listener);
  };
}

export function storeEvent(runId: string, event: SubagentStreamEvent): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.events.push(event);
  notifyListeners(event);
}

function extractToolResultContent(content: Array<TextContent | ImageContent>): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  const textParts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return { text: textParts.join('\n'), images };
}

export function normalizePiEvent(
  runId: string,
  event: AgentSessionEvent,
): SubagentStreamEvent | null {
  if (event.type === 'message_update') {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (!assistantMessageEvent) return null;
    if (assistantMessageEvent.type === 'text_delta') {
      return { runId, type: 'text', delta: assistantMessageEvent.delta };
    }
    if (assistantMessageEvent.type === 'toolcall_start') {
      const block =
        assistantMessageEvent.partial?.content?.[
          assistantMessageEvent.contentIndex
        ];
      if (block?.type !== 'toolCall') return null;
      return {
        runId,
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
      };
    }
    if (assistantMessageEvent.type === 'toolcall_delta') {
      const block =
        assistantMessageEvent.partial?.content?.[
          assistantMessageEvent.contentIndex
        ];
      if (block?.type !== 'toolCall') return null;
      return {
        runId,
        type: 'tool-args',
        toolCallId: block.id,
        delta: assistantMessageEvent.delta,
      };
    }
    if (assistantMessageEvent.type === 'toolcall_end') {
      const call = assistantMessageEvent.toolCall;
      if (!call) return null;
      return {
        runId,
        type: 'tool-call-end',
        toolCallId: call.id,
        args: call.arguments,
      };
    }
    return null;
  }
  if (event.type === 'tool_execution_start') {
    return {
      runId,
      type: 'tool-start',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
  }
  if (event.type === 'tool_execution_end') {
    const result = extractToolResultContent(event.result.content);
    return {
      runId,
      type: 'tool-end',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: result.text,
      ...(result.images.length > 0 ? { images: result.images } : {}),
      isError: event.isError || event.result.details?.isError === true,
    };
  }
  return null;
}
