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
  signal?: AbortSignal;
  onEvent: (event: LoopEvent) => void;
}

export async function runAgentLoop(deps: RunAgentLoopDeps): Promise<void> {
  const messages: ChatMessage[] = [...deps.messages];
  const systemMessage: ChatMessage = {
    role: 'system',
    content: `You are agent-os, a macOS AI agent. Current working directory is the agent home directory.`,
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
