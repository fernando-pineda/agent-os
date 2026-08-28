import type {
  ChatMessage,
  LLMClient,
  LLMEvent,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from './types.js';

export type LoopEvent =
  | LLMEvent
  | { type: 'tool-result'; toolCallId: string; result: ToolResult };

interface RunAgentLoopDeps {
  llm: LLMClient;
  tools: Tool[];
  model: string;
  messages: ChatMessage[];
  agentId?: string;
  role?: string;
  memoryIndex?: string;
  signal?: AbortSignal;
  onEvent: (event: LoopEvent) => void;
}

function buildSystemPrompt(deps: RunAgentLoopDeps): string {
  const toolNames = deps.tools.map((t) => t.spec.name).join(', ');
  const now = new Date();
  const identity = [
    'You are an autonomous macOS agent in the agent-os system.',
    deps.agentId ? `Your id is "${deps.agentId}".` : '',
    `You run on the model ${deps.model}.`,
    `Current date and time: ${now.toISOString()} (${now.toString()}).`,
    deps.role ? `Your responsibility in the team is: ${deps.role}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const capabilities = `You operate on a real macOS machine with these tools: ${toolNames}. Shell commands run in your own home directory, which is fully yours: clone repos, write files, install things there. You can message other agents with message_agent when a task needs a teammate.`;

  const behavior = [
    'Work with tools, not with descriptions of what you would do. If the task needs a command, run it.',
    'Prefer one precise tool call over a long explanation. Report results in one or two sentences after acting.',
    'Never invent command output. If a tool fails, read the error and adapt.',
    'Stay inside your home directory unless the task explicitly requires otherwise.',
    'Answer in the same language the user writes in.',
  ].join(' ');

  const memory = deps.memoryIndex?.trim()
    ? `\n\nLong-term memory from previous sessions follows. Use it silently; never mention this index unless the user asks about your memory.\n\n${deps.memoryIndex.trim()}`
    : '';

  return `${identity}\n\n${capabilities}\n\n${behavior}${memory}`;
}

export async function runAgentLoop(deps: RunAgentLoopDeps): Promise<void> {
  const messages: ChatMessage[] = [...deps.messages];
  const systemMessage: ChatMessage = {
    role: 'system',
    content: buildSystemPrompt(deps),
  };

  const hasSystem = messages.some((m) => m.role === 'system');
  if (!hasSystem) {
    messages.unshift(systemMessage);
  }

  const toolSpecs = deps.tools.map((t) => t.spec);
  const maxIterations = 25;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (deps.signal?.aborted) {
      return;
    }

    const toolCalls: ToolCall[] = [];
    let textContent = '';
    let _done = false;
    let _usage:
      | { promptTokens?: number; completionTokens?: number }
      | undefined;

    const stream = deps.llm.stream(
      {
        model: deps.model,
        messages,
        tools: toolSpecs,
        temperature: 0.1,
      },
      deps.signal,
    );

    for await (const event of stream) {
      deps.onEvent(event);
      if (event.type === 'text-delta') {
        textContent += event.delta;
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call);
      } else if (event.type === 'done') {
        _done = true;
        _usage = event.usage;
      } else if (event.type === 'error') {
        return;
      }
    }

    if (toolCalls.length === 0) {
      break;
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: textContent,
      toolCalls,
    };
    messages.push(assistantMessage);

    for (const call of toolCalls) {
      const tool = deps.tools.find((t) => t.spec.name === call.name);
      const ctx: ToolContext = {
        agentId: 'agent',
        workspace: 'default',
        homeDir: process.cwd(),
        signal: deps.signal,
      };
      const result = tool
        ? await tool.execute(call.args, ctx)
        : { ok: false, output: `unknown tool: ${call.name}` };
      deps.onEvent({ type: 'tool-result', toolCallId: call.id, result });
      messages.push({
        role: 'tool',
        content: result.output,
        toolCallId: call.id,
      });
    }
  }
}
