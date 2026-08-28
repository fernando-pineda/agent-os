import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { json } from 'node:stream/consumers';
import type {
  AgentConfig,
  ChatMessage,
  LLMClient,
  LoopEvent,
  Tool,
  ToolContext,
  ToolResult,
} from '@agent-os/core';
import { runAgentLoop } from '@agent-os/core';
import {
  type AssistantStreamController,
  createAssistantStreamResponse,
  ToolResponse,
} from 'assistant-stream';
import type { ReadonlyJSONValue } from 'assistant-stream/utils';
import { myPort, readRegistry } from './registry.js';
import {
  loadThread,
  saveThread,
  type UIMessage,
  uiMessagesToChat,
} from './thread.js';

export type AgentStatus = 'starting' | 'online' | 'busy' | 'error' | 'stopped';

export interface ServerDeps {
  agentId: string;
  workspace: string;
  homeDir: string;
  agent: AgentConfig;
  model: string;
  llm: LLMClient;
  tools: Tool[];
  status: AgentStatus;
  currentTaskId?: string;
  onStatusChange: (status: AgentStatus) => void;
  buildContext: (signal?: AbortSignal) => ToolContext;
  sendAgentMessage: (toAgentId: string, message: string) => Promise<string>;
}

export interface AgentServer {
  start: () => Promise<number>;
  stop: () => Promise<void>;
  setStatus: (status: AgentStatus) => void;
  setCurrentTaskId: (taskId: string | undefined) => void;
}

interface ToolCallContext {
  controller: ToolCallStreamController;
  argsText: string;
}

type NewAssistantPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };

interface RunControls {
  setStatus: (status: AgentStatus) => void;
  setCurrentTaskId: (taskId: string | undefined) => void;
  markRunning: (value: boolean) => void;
}

export function createAgentServer(deps: ServerDeps): AgentServer {
  let status = deps.status;
  let currentTaskId = deps.currentTaskId;
  let running = false;
  let runningController: AbortController | undefined;
  const server = createServer();
  let _listenPort: number | undefined;

  const setStatus = (newStatus: AgentStatus) => {
    status = newStatus;
    deps.onStatusChange(newStatus);
  };

  const setCurrentTaskId = (taskId: string | undefined) => {
    currentTaskId = taskId;
  };

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status, currentTaskId }));
        return;
      }

      if (method === 'GET' && url === '/messages') {
        const messages = await loadThread(deps.homeDir);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(messages));
        return;
      }

      if (method === 'POST' && url === '/chat') {
        if (running) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent is busy' }));
          return;
        }
        const body = (await json(req)) as { messages?: UIMessage[] };
        const messages = body.messages ?? [];
        const response = await handleChat(messages, deps, {
          setStatus,
          setCurrentTaskId,
          markRunning,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        if (response.body) {
          const reader = response.body.getReader();
          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              return;
            }
            res.write(value);
            return pump();
          };
          await pump();
          return;
        }
        res.end();
        return;
      }

      if (method === 'POST' && url === '/inbox') {
        const body = (await json(req)) as {
          fromAgentId?: string;
          taskId?: string;
          message?: string;
        };
        const fromAgentId =
          typeof body.fromAgentId === 'string' ? body.fromAgentId : 'unknown';
        const taskId =
          typeof body.taskId === 'string' ? body.taskId : crypto.randomUUID();
        const message = typeof body.message === 'string' ? body.message : '';
        const reply = await handleInbox(fromAgentId, taskId, message, deps, {
          setStatus,
          setCurrentTaskId,
          markRunning,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reply }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('HTTP request error', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });

  const markRunning = (value: boolean) => {
    running = value;
  };

  return {
    async start() {
      const port = await myPort(deps.agentId);
      if (!port) {
        throw new Error(`No port configured for agent ${deps.agentId}`);
      }
      _listenPort = port;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return port;
    },
    async stop() {
      runningController?.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    setStatus,
    setCurrentTaskId,
  };

  async function handleChat(
    messages: UIMessage[],
    serverDeps: ServerDeps,
    controls: RunControls,
  ): Promise<Response> {
    const taskId = crypto.randomUUID();
    controls.setCurrentTaskId(taskId);
    controls.setStatus('busy');
    controls.markRunning(true);
    runningController = new AbortController();

    const chatMessages = uiMessagesToChat(messages);
    const toolContexts = new Map<string, ToolCallContext>();
    const textParts: string[] = [];
    const newAssistantParts: NewAssistantPart[] = [];
    const controller = runningController;

    return createAssistantStreamResponse(
      async (streamController: AssistantStreamController) => {
        try {
          await runAgentLoop({
            llm: serverDeps.llm,
            tools: serverDeps.tools,
            model: serverDeps.model,
            messages: chatMessages,
            signal: controller.signal,
            onEvent: (event: LoopEvent) => {
              handleStreamEvent(
                event,
                streamController,
                toolContexts,
                newAssistantParts,
                textParts,
              );
            },
          });
          await persistTurn(messages, newAssistantParts, textParts, serverDeps);
          // AI SDK data-stream needs explicit finish frames to complete.
          const finishUsage = { inputTokens: 0, outputTokens: 0 };
          streamController.enqueue({
            type: 'step-finish',
            finishReason: 'stop',
            usage: finishUsage,
            isContinued: false,
          } as never);
          streamController.enqueue({
            type: 'message-finish',
            finishReason: 'stop',
            usage: finishUsage,
          } as never);
        } catch (err) {
          streamController.appendText(
            `\nError: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          controls.setStatus('online');
          controls.setCurrentTaskId(undefined);
          controls.markRunning(false);
          streamController.close();
        }
      },
    );
  }

  async function handleInbox(
    fromAgentId: string,
    taskId: string,
    message: string,
    serverDeps: ServerDeps,
    controls: RunControls,
  ): Promise<string> {
    controls.setCurrentTaskId(taskId);
    controls.setStatus('busy');
    controls.markRunning(true);
    runningController = new AbortController();

    const chatMessages: ChatMessage[] = [
      {
        role: 'user',
        content: `Message from agent ${fromAgentId}: ${message}`,
      },
    ];

    const toolContexts = new Map<string, ToolCallContext>();
    const textParts: string[] = [];
    const newAssistantParts: NewAssistantPart[] = [];
    const replyParts: string[] = [];
    const controller = runningController;

    try {
      await runAgentLoop({
        llm: serverDeps.llm,
        tools: serverDeps.tools,
        model: serverDeps.model,
        messages: chatMessages,
        signal: controller.signal,
        onEvent: (event: LoopEvent) => {
          if (event.type === 'text-delta') {
            replyParts.push(event.delta);
          }
          handleStreamEvent(
            event,
            undefined,
            toolContexts,
            newAssistantParts,
            textParts,
          );
        },
      });
      const text = replyParts.join('');
      await persistTurn([], newAssistantParts, textParts, serverDeps);
      return text;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      controls.setStatus('online');
      controls.setCurrentTaskId(undefined);
      controls.markRunning(false);
    }
  }
}

import type { ToolCallStreamController } from 'assistant-stream';

function handleStreamEvent(
  event: LoopEvent,
  controller: AssistantStreamController | undefined,
  toolContexts: Map<string, ToolCallContext>,
  newAssistantParts: NewAssistantPart[],
  textParts: string[],
): void {
  if (event.type === 'text-delta') {
    controller?.appendText(event.delta);
    textParts.push(event.delta);
  } else if (event.type === 'tool-call') {
    const call = event.call;
    const toolController = controller?.addToolCallPart({
      toolCallId: call.id,
      toolName: call.name,
      args: call.args as Record<string, ReadonlyJSONValue>,
    });
    if (toolController) {
      toolContexts.set(call.id, { controller: toolController, argsText: '' });
    }
    newAssistantParts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      args: call.args,
    });
  } else if (event.type === 'tool-result') {
    const result = event.result as ToolResult;
    const ctx = toolContexts.get(event.toolCallId);
    if (ctx) {
      ctx.controller.setResponse(
        new ToolResponse({
          result: result.output,
          isError: result.ok === false,
        }),
      );
    }
  }
}

async function persistTurn(
  existingMessages: UIMessage[],
  newAssistantParts: NewAssistantPart[],
  textParts: string[],
  deps: ServerDeps,
): Promise<void> {
  // Persist the full thread as sent by the client (it already includes the
  // new user message) merged with anything stored that the client missed.
  const stored = await loadThread(deps.homeDir);
  const storedIds = new Set(
    stored.map((m) => m.id).filter((id): id is string => Boolean(id)),
  );
  const incoming = existingMessages.filter(
    (m) => !m.id || !storedIds.has(m.id),
  );
  const messages = [...stored, ...incoming];
  const assistantParts: UIMessage['parts'] = [];
  if (textParts.length > 0) {
    assistantParts.push({ type: 'text', text: textParts.join('') });
  }
  for (const part of newAssistantParts) {
    if (part.type === 'tool-call') {
      assistantParts.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
      });
    }
  }
  const assistantMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: textParts.join(''),
  };
  if (assistantParts.length > 0) {
    assistantMessage.parts = assistantParts;
  }
  messages.push(assistantMessage);
  await saveThread(deps.homeDir, messages);
}

export async function sendAgentMessageHttp(
  toAgentId: string,
  message: string,
): Promise<string> {
  const registry = await readRegistry();
  const entry = registry.agents.find((a) => a.id === toAgentId);
  if (!entry) {
    throw new Error(`Agent ${toAgentId} not found in registry`);
  }
  const res = await fetch(`http://localhost:${entry.port}/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAgentId: process.env.AGENT_ID ?? 'unknown',
      taskId: crypto.randomUUID(),
      message,
    }),
  });
  if (!res.ok) {
    throw new Error(`Agent ${toAgentId} inbox returned ${res.status}`);
  }
  const body = (await res.json()) as { reply?: string };
  return body.reply ?? '';
}
