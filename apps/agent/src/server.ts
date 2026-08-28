import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { json } from 'node:stream/consumers';
import type {
  AgentConfig,
  AgentStatus,
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
import { loadMemoryIndex } from './compact.js';
import { findPortFor, myPort } from './registry.js';
import {
  loadThread,
  loadUsage,
  saveThread,
  saveUsage,
  type UIMessage,
  uiMessagesToChat,
} from './thread.js';

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
  isBusy: () => boolean;
}

interface ToolCallContext {
  controller: ToolCallStreamController;
  argsText: string;
}

interface TurnSegment {
  kind: 'text' | 'tool';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

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

      if (method === 'GET' && url === '/usage') {
        const usage = await loadUsage(deps.homeDir);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(usage));
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
          replyTo?: string;
          inReplyTo?: string;
        };
        if (running) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent is busy' }));
          return;
        }
        const fromAgentId =
          typeof body.fromAgentId === 'string' ? body.fromAgentId : 'unknown';
        const taskId =
          typeof body.taskId === 'string' ? body.taskId : crypto.randomUUID();
        const message = typeof body.message === 'string' ? body.message : '';
        const replyTo =
          typeof body.replyTo === 'string' ? body.replyTo : fromAgentId;
        const inboxBody: {
          fromAgentId: string;
          taskId: string;
          message: string;
          replyTo: string;
          inReplyTo?: string;
        } = { fromAgentId, taskId, message, replyTo };
        if (typeof body.inReplyTo === 'string') {
          inboxBody.inReplyTo = body.inReplyTo;
        }
        const result = await handleInbox(inboxBody, deps, {
          setStatus,
          setCurrentTaskId,
          markRunning,
        });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
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
    isBusy: () => running,
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
    const segments: TurnSegment[] = [];
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    const controller = runningController;

    return createAssistantStreamResponse(
      async (streamController: AssistantStreamController) => {
        try {
          const memoryIndex = await loadMemoryIndex(serverDeps.homeDir);
          await runAgentLoop({
            llm: serverDeps.llm,
            tools: serverDeps.tools,
            model: serverDeps.model,
            messages: chatMessages,
            agentId: serverDeps.agentId,
            ...(serverDeps.agent.role ? { role: serverDeps.agent.role } : {}),
            ...(memoryIndex ? { memoryIndex } : {}),
            buildContext: serverDeps.buildContext,
            signal: controller.signal,
            onEvent: (event: LoopEvent) => {
              if (event.type === 'done' && event.usage) {
                lastUsage = {
                  inputTokens: event.usage.promptTokens ?? 0,
                  outputTokens: event.usage.completionTokens ?? 0,
                };
              }
              handleStreamEvent(
                event,
                streamController,
                toolContexts,
                segments,
              );
            },
          });
          await persistTurn(messages, segments, serverDeps);
          if (lastUsage) {
            await saveUsage(serverDeps.homeDir, lastUsage);
          }
          // AI SDK data-stream needs explicit finish frames to complete.
          const finishUsage = lastUsage ?? { inputTokens: 0, outputTokens: 0 };
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
    body: {
      fromAgentId: string;
      taskId: string;
      message: string;
      replyTo: string;
      inReplyTo?: string;
    },
    serverDeps: ServerDeps,
    controls: RunControls,
  ): Promise<{ accepted: true; id: string }> {
    controls.setCurrentTaskId(body.taskId);
    controls.setStatus('busy');
    controls.markRunning(true);
    runningController = new AbortController();

    const prefix = body.inReplyTo ? 'Reply from agent' : 'Message from agent';
    const chatMessages: ChatMessage[] = [
      {
        role: 'user',
        content: `${prefix} ${body.fromAgentId}: ${body.message}`,
      },
    ];

    const controller = runningController;

    void processInbox(
      body,
      chatMessages,
      serverDeps,
      controls,
      controller,
    ).catch((err) => console.error('Inbox task failed', err));

    return { accepted: true, id: serverDeps.agentId };
  }

  async function processInbox(
    body: {
      fromAgentId: string;
      taskId: string;
      message: string;
      replyTo: string;
      inReplyTo?: string;
    },
    chatMessages: ChatMessage[],
    serverDeps: ServerDeps,
    controls: RunControls,
    controller: AbortController,
  ): Promise<void> {
    const toolContexts = new Map<string, ToolCallContext>();
    const segments: TurnSegment[] = [];
    const replyParts: string[] = [];
    let text = '';

    try {
      await runAgentLoop({
        llm: serverDeps.llm,
        tools: serverDeps.tools,
        model: serverDeps.model,
        messages: chatMessages,
        agentId: serverDeps.agentId,
        ...(serverDeps.agent.role ? { role: serverDeps.agent.role } : {}),
        buildContext: serverDeps.buildContext,
        signal: controller.signal,
        onEvent: (event: LoopEvent) => {
          if (event.type === 'text-delta') {
            replyParts.push(event.delta);
          }
          handleStreamEvent(event, undefined, toolContexts, segments);
        },
      });
      text = replyParts.join('');
      await persistTurn([], segments, serverDeps);
    } catch (err) {
      console.error('Inbox loop error', err);
      text = err instanceof Error ? err.message : String(err);
    } finally {
      controls.setStatus('online');
      controls.setCurrentTaskId(undefined);
      controls.markRunning(false);
    }

    if (
      !text ||
      !body.replyTo ||
      body.replyTo === 'unknown' ||
      body.inReplyTo
    ) {
      return;
    }

    try {
      const port = await findPortFor(body.replyTo);
      if (!port) return;
      await fetch(`http://localhost:${port}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fromAgentId: serverDeps.agentId,
          message: text,
          inReplyTo: body.taskId,
        }),
      });
    } catch (err) {
      console.error('Inbox reply callback failed', err);
    }
  }
}

import type { ToolCallStreamController } from 'assistant-stream';

function handleStreamEvent(
  event: LoopEvent,
  controller: AssistantStreamController | undefined,
  toolContexts: Map<string, ToolCallContext>,
  segments: TurnSegment[],
): void {
  const last = segments[segments.length - 1];
  if (event.type === 'text-delta') {
    controller?.appendText(event.delta);
    if (last?.kind === 'text') {
      last.text = (last.text ?? '') + event.delta;
    } else if (last?.kind === 'tool') {
      // Text after a tool continues the same message; keep it as a new
      // text segment so the grouper appends it to the tool message.
      segments.push({ kind: 'text', text: event.delta });
    } else {
      segments.push({ kind: 'text', text: event.delta });
    }
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
    segments.push({
      kind: 'tool',
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
    const seg = segments.find(
      (s) => s.kind === 'tool' && s.toolCallId === event.toolCallId,
    );
    if (seg) {
      seg.result = result.output;
      seg.isError = result.ok === false;
    }
  }
}

async function persistTurn(
  existingMessages: UIMessage[],
  segments: TurnSegment[],
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

  // Group segments into messages: a tool call starts a new message;
  // following text joins that message. Leading text is its own message.
  let current: UIMessage | undefined;
  const flush = (): void => {
    if (current && (current.content || (current.parts?.length ?? 0) > 0)) {
      messages.push(current);
    }
    current = undefined;
  };
  for (const seg of segments) {
    if (seg.kind === 'text' && seg.text) {
      if (!current) {
        current = { id: crypto.randomUUID(), role: 'assistant', content: '' };
      }
      current.content = (current.content ?? '') + seg.text;
      const parts = current.parts ?? [];
      const lastText = parts[parts.length - 1];
      if (lastText?.type === 'text') {
        lastText.text += seg.text;
      } else {
        parts.push({ type: 'text', text: seg.text });
      }
      current.parts = parts;
    } else if (seg.kind === 'tool' && seg.toolCallId) {
      // Tool call joins the current message; following text continues it.
      if (!current) {
        current = { id: crypto.randomUUID(), role: 'assistant' };
      }
      const parts = current.parts ?? [];
      parts.push({
        type: 'tool-call',
        toolCallId: seg.toolCallId,
        toolName: seg.toolName ?? '',
        args: seg.args ?? {},
        ...(seg.result !== undefined && { result: seg.result }),
        ...(seg.isError !== undefined && { isError: seg.isError }),
      });
      current.parts = parts;
    }
  }
  flush();
  await saveThread(deps.homeDir, messages);
}

export async function sendAgentMessageHttp(
  toAgentId: string,
  message: string,
): Promise<string> {
  const port = await findPortFor(toAgentId);
  if (!port) {
    return `Agent ${toAgentId} is unreachable (not running?).`;
  }

  try {
    const res = await fetch(`http://localhost:${port}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromAgentId: process.env.AGENT_ID ?? 'unknown',
        taskId: crypto.randomUUID(),
        message,
        replyTo: process.env.AGENT_ID ?? 'unknown',
      }),
    });

    if (res.status === 409) {
      return `Agent ${toAgentId} is busy with another task; your message was not delivered. Try again later.`;
    }
    if (!res.ok) {
      return `Agent ${toAgentId} is unreachable (not running?).`;
    }
    return `Message delivered to ${toAgentId}. They will reply when done.`;
  } catch {
    return `Agent ${toAgentId} is unreachable (not running?).`;
  }
}
