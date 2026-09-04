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
  PiSessionHandle,
  Tool,
  ToolContext,
  TurnSegment,
} from '@agent-os/core';
import {
  type AssistantStreamController,
  createAssistantStreamResponse,
  type ToolCallStreamController,
  ToolResponse,
} from 'assistant-stream';
import { Cron } from 'croner';
import type { Automation, AutomationScheduler } from './automations.js';
import { appendOutbox } from './outbox.js';
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
  supportsVision?: boolean;
  sessionHandle: PiSessionHandle;
  tools: Tool[];
  status: AgentStatus;
  currentTaskId?: string;
  onStatusChange: (status: AgentStatus) => void;
  buildContext: (signal?: AbortSignal) => ToolContext;
  sendAgentMessage: (
    toAgentId: string,
    message: string,
    opts?: { replyDepth?: number; taskId?: string },
  ) => Promise<string>;
  onMessagesPersisted?: (messages: UIMessage[]) => void;
  scheduler?: AutomationScheduler;
  onPluginsReload?: () => Promise<{
    tools: Tool[];
    sessionHandle: PiSessionHandle;
  }>;
  turnState: { replyDepth: number; atCap: boolean };
}

export interface AgentServer {
  start: () => Promise<number>;
  stop: () => Promise<void>;
  setStatus: (status: AgentStatus) => void;
  setCurrentTaskId: (taskId: string | undefined) => void;
  isBusy: () => boolean;
  setScheduler: (scheduler: AutomationScheduler) => void;
}

interface RunControls {
  setStatus: (status: AgentStatus) => void;
  setCurrentTaskId: (taskId: string | undefined) => void;
  markRunning: (value: boolean) => void;
}

// Max hops in an agent-to-agent reply chain before the receiver is told to stop.
const MAX_AGENT_REPLY_DEPTH = 6;
// Turn reminder appended to inbound replies so the agent weighs ending it.
const REPLY_TURN_REMINDER =
  '[system: this is a reply in an ongoing exchange. If it still carries a task or question, answer it and send the answer back with message_agent as usual. Only skip message_agent when it is purely social (farewell, acknowledgment, thanks) with nothing left to do.]';

export function createAgentServer(deps: ServerDeps): AgentServer {
  let status = deps.status;
  let currentTaskId = deps.currentTaskId;
  let running = false;
  let sessionHandle = deps.sessionHandle;
  let scheduler: AutomationScheduler | undefined = deps.scheduler;
  const server = createServer();
  let _listenPort: number | undefined;
  const messageListeners = new Set<ServerResponse>();

  const notifyMessages = (messages: UIMessage[]) => {
    const payload = `data: ${JSON.stringify({ messages })}\n\n`;
    for (const l of messageListeners) {
      try {
        l.write(payload);
      } catch {
        messageListeners.delete(l);
      }
    }
  };

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

      if (method === 'GET' && url === '/messages/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        messageListeners.add(res);
        req.on('close', () => messageListeners.delete(res));
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
        const response = await handleChat(
          messages,
          { ...deps, sessionHandle, onMessagesPersisted: notifyMessages },
          {
            setStatus,
            setCurrentTaskId,
            markRunning,
          },
        );
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
          replyDepth?: number;
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
        const replyDepth =
          typeof body.replyDepth === 'number' ? body.replyDepth : 0;
        const inboxBody: {
          fromAgentId: string;
          taskId: string;
          message: string;
          inReplyTo?: string;
          replyDepth: number;
        } = { fromAgentId, taskId, message, replyDepth };
        if (typeof body.inReplyTo === 'string') {
          inboxBody.inReplyTo = body.inReplyTo;
        }
        const result = await handleInbox(
          inboxBody,
          { ...deps, sessionHandle, onMessagesPersisted: notifyMessages },
          {
            setStatus,
            setCurrentTaskId,
            markRunning,
          },
        );
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // GET /tools - list all available tools (built-in + MCP)
      if (method === 'GET' && url === '/tools') {
        const list = sessionHandle.session.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tools: list }));
        return;
      }

      // POST /abort - cancel the currently running turn
      if (method === 'POST' && url === '/abort') {
        if (!running) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'No run in progress' }));
          return;
        }
        void sessionHandle.abort().catch((err) => {
          console.error('Failed to abort agent session', err);
        });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /plugins/reload - reconnect MCPs from current config without restart
      if (method === 'POST' && url === '/plugins/reload') {
        if (!deps.onPluginsReload) {
          res.writeHead(501, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin reload not supported' }));
          return;
        }
        try {
          const next = await deps.onPluginsReload();
          sessionHandle = next.sessionHandle;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              tools: next.tools.map((t) => t.spec.name),
            }),
          );
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      // GET /automations - list all automations
      if (method === 'GET' && url === '/automations') {
        const automations = scheduler ? await scheduler.list() : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ automations }));
        return;
      }

      // POST /automations - create/upsert an automation
      if (method === 'POST' && url === '/automations') {
        if (!scheduler) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Scheduler not available' }));
          return;
        }
        const body = (await json(req)) as Partial<Automation>;
        const id =
          typeof body.id === 'string' && body.id.length > 0
            ? body.id
            : `auto-${crypto.randomUUID()}`;
        const cron = typeof body.cron === 'string' ? body.cron : '';
        const tool = typeof body.tool === 'string' ? body.tool : '';
        const name = typeof body.name === 'string' ? body.name : '';
        if (!cron) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'cron is required' }));
          return;
        }
        const prompt =
          typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!tool && !prompt) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'prompt is required when no tool is bound',
            }),
          );
          return;
        }
        // validate cron expression
        try {
          const testJob = new Cron(cron, () => {});
          testJob.stop();
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: `Invalid cron expression: ${cron}` }),
          );
          return;
        }
        const automation: Automation = {
          id,
          name,
          cron,
          ...(tool ? { tool } : {}),
          ...(body.args && typeof body.args === 'object'
            ? { args: body.args as Record<string, unknown> }
            : {}),
          ...(prompt ? { prompt } : {}),
          ...(typeof body.cursor === 'string' ? { cursor: body.cursor } : {}),
          delivery: body.delivery === 'silent' ? 'silent' : 'inbox',
          enabled: body.enabled !== false,
          ...(typeof body.createdAt === 'string'
            ? { createdAt: body.createdAt }
            : { createdAt: new Date().toISOString() }),
        };
        const saved = await scheduler.upsert(automation);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(saved));
        return;
      }

      // /automations/:id routes
      const autoMatch = url.match(/^\/automations\/([^/]+)(?:\/run)?$/);
      if (autoMatch?.[1]) {
        const id = autoMatch[1];
        const isRun = url.endsWith('/run');

        if (method === 'GET' && !isRun) {
          const automations = scheduler ? await scheduler.list() : [];
          const automation = automations.find((a) => a.id === id);
          if (!automation) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Automation not found' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(automation));
          return;
        }

        if (method === 'PATCH' && !isRun) {
          if (!scheduler) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Scheduler not available' }));
            return;
          }
          const automations = await scheduler.list();
          const existing = automations.find((a) => a.id === id);
          if (!existing) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Automation not found' }));
            return;
          }
          const body = (await json(req)) as Partial<Automation>;
          const updated: Automation = {
            ...existing,
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
            ...(typeof body.cron === 'string' ? { cron: body.cron } : {}),
            ...(typeof body.tool === 'string' ? { tool: body.tool } : {}),
            ...(body.args && typeof body.args === 'object'
              ? { args: body.args as Record<string, unknown> }
              : {}),
            ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
            ...(typeof body.cursor === 'string' ? { cursor: body.cursor } : {}),
            ...(body.delivery === 'silent' || body.delivery === 'inbox'
              ? { delivery: body.delivery }
              : {}),
            ...(typeof body.enabled === 'boolean'
              ? { enabled: body.enabled }
              : {}),
          };
          // validate cron expression if it changed
          try {
            const testJob = new Cron(updated.cron, () => {});
            testJob.stop();
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Invalid cron expression: ${updated.cron}`,
              }),
            );
            return;
          }
          const saved = await scheduler.upsert(updated);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(saved));
          return;
        }

        if (method === 'DELETE' && !isRun) {
          if (!scheduler) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Scheduler not available' }));
            return;
          }
          const removed = await scheduler.remove(id);
          if (!removed) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Automation not found' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (method === 'POST' && isRun) {
          if (!scheduler) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Scheduler not available' }));
            return;
          }
          const result = await scheduler.runNow(id);
          if (!result.ran) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Automation not found' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              ...(result.summary ? { summary: result.summary } : {}),
            }),
          );
          return;
        }
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
      if (running) {
        await sessionHandle.abort();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    setStatus,
    setCurrentTaskId,
    isBusy: () => running,
    setScheduler: (s: AutomationScheduler) => {
      scheduler = s;
    },
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
    const chatMessages = uiMessagesToChat(messages);
    const promptText =
      [...chatMessages].reverse().find((message) => message.role === 'user')
        ?.content ?? '';
    const userImages = extractUserImages(messages);
    const toolContexts = new Map<string, ToolCallContext>();
    const segments: TurnSegment[] = [];
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    const controller = new AbortController();

    return createAssistantStreamResponse(
      async (streamController: AssistantStreamController) => {
        let finishSent = false;
        const persistPartial = (): Promise<void> =>
          enqueuePersist(() => persistTurn(messages, segments, serverDeps));
        const sendFinish = (): void => {
          if (finishSent) return;
          finishSent = true;
          const finishUsage = lastUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
          };
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
        };
        const unsubscribe = serverDeps.sessionHandle.subscribe((event) => {
          handleSessionEvent(
            event,
            streamController,
            toolContexts,
            segments,
            (usage) => {
              lastUsage = usage;
            },
            sendFinish,
          );
          if (
            event.type === 'tool_execution_end' ||
            event.type === 'agent_end'
          ) {
            void persistPartial().catch((err) => {
              console.error('Failed to persist partial turn', err);
            });
          }
        });
        try {
          await serverDeps.sessionHandle.prompt(
            promptText,
            controller.signal,
            userImages,
          );
          await enqueuePersist(() =>
            persistTurn(messages, segments, serverDeps),
          );
          if (lastUsage) {
            await saveUsage(serverDeps.homeDir, lastUsage);
          }
          sendFinish();
        } catch (err) {
          streamController.appendText(
            `\nError: ${err instanceof Error ? err.message : String(err)}`,
          );
          sendFinish();
        } finally {
          unsubscribe();
          controller.abort();
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
      inReplyTo?: string;
      replyDepth: number;
    },
    serverDeps: ServerDeps,
    controls: RunControls,
  ): Promise<{ accepted: true; id: string }> {
    controls.setCurrentTaskId(body.taskId);
    controls.setStatus('busy');
    controls.markRunning(true);

    const prefix = body.inReplyTo ? 'Reply from agent' : 'Message from agent';
    const depth = body.replyDepth;
    const atCap = depth >= MAX_AGENT_REPLY_DEPTH;
    const closingNote = atCap
      ? `\n\n[system: this exchange has reached the reply limit (${MAX_AGENT_REPLY_DEPTH}). Do NOT reply with message_agent. Acknowledge briefly in plain text and stop.]`
      : depth >= MAX_AGENT_REPLY_DEPTH - 1
        ? `\n\n[system: this exchange is about to hit the reply limit. Wrap it up; reply only if truly necessary.]`
        : '';
    const turnReminder = body.inReplyTo ? `\n\n${REPLY_TURN_REMINDER}` : '';
    const chatMessages: ChatMessage[] = [
      {
        role: 'user',
        content: `[agent-os:inbox from=${body.fromAgentId}${body.inReplyTo ? ' reply' : ''} task=${body.taskId}] ${prefix} ${body.fromAgentId}: ${body.message}${closingNote}${turnReminder}`,
      },
    ];

    const controller = new AbortController();

    serverDeps.turnState.replyDepth = depth;
    serverDeps.turnState.atCap = atCap;

    void processInbox(
      {
        fromAgentId: body.fromAgentId,
        replyDepth: depth,
        atCap,
        taskId: body.taskId,
        ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
      },
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
      inReplyTo?: string;
      replyDepth: number;
      atCap: boolean;
      taskId: string;
    },
    chatMessages: ChatMessage[],
    serverDeps: ServerDeps,
    controls: RunControls,
    controller: AbortController,
  ): Promise<void> {
    const toolContexts = new Map<string, ToolCallContext>();
    const segments: TurnSegment[] = [];
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = serverDeps.sessionHandle.subscribe((event) => {
        handleSessionEvent(
          event,
          undefined,
          toolContexts,
          segments,
          undefined,
          undefined,
        );
      });
      await serverDeps.sessionHandle.prompt(
        chatMessages[0]?.content ?? '',
        controller.signal,
      );
      const inbound: UIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [
          {
            type: 'text',
            text: chatMessages[0]?.content ?? '',
          },
        ],
        metadata: {
          agentOsInbox: true,
          fromAgentId: body.fromAgentId,
          taskId: body.taskId,
          ...(body.inReplyTo ? { reply: true } : {}),
        },
      };
      await persistTurn([inbound], segments, serverDeps, {
        replyToAgentId: body.fromAgentId,
      });
    } catch (err) {
      console.error('Inbox loop error', err);
    } finally {
      serverDeps.turnState.replyDepth = 0;
      serverDeps.turnState.atCap = false;
      unsubscribe?.();
      controller.abort();
      controls.setStatus('online');
      controls.setCurrentTaskId(undefined);
      controls.markRunning(false);
    }
  }
}

function extractUserImages(
  messages: UIMessage[],
): Array<{ data: string; mimeType: string }> | undefined {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return undefined;
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of lastUser.parts ?? []) {
    if (part.type === 'image' && part.image) {
      const src = part.image;
      if (typeof src === 'string' && src.startsWith('data:')) {
        const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(src);
        if (match?.[1] && match?.[2]) {
          images.push({ mimeType: match[1], data: match[2] });
        }
      }
    }
  }
  return images.length > 0 ? images : undefined;
}

type PiSessionEvent = Parameters<
  Parameters<PiSessionHandle['subscribe']>[0]
>[0];

interface ToolCallContext {
  controller?: ToolCallStreamController;
  argsText?: ToolCallStreamController['argsText'];
}

function handleSessionEvent(
  event: PiSessionEvent,
  controller: AssistantStreamController | undefined,
  toolContexts: Map<string, ToolCallContext>,
  segments: TurnSegment[],
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
  onAgentEnd?: () => void,
): void {
  const last = segments[segments.length - 1];
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === 'text_delta') {
      controller?.appendText(assistantEvent.delta);
      if (last?.kind === 'text') {
        last.text = (last.text ?? '') + assistantEvent.delta;
      } else if (last?.kind === 'tool') {
        segments.push({ kind: 'text', text: assistantEvent.delta });
      } else {
        segments.push({ kind: 'text', text: assistantEvent.delta });
      }
      return;
    }
    if (assistantEvent.type === 'toolcall_start') {
      const block = assistantEvent.partial.content[assistantEvent.contentIndex];
      if (block?.type !== 'toolCall') return;
      const toolController = controller?.addToolCallPart({
        toolCallId: block.id,
        toolName: block.name,
        args: {},
      });
      toolContexts.set(block.id, {
        ...(toolController ? { controller: toolController } : {}),
        ...(toolController ? { argsText: toolController.argsText } : {}),
      });
      segments.push({
        kind: 'tool',
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments,
      });
      return;
    }
    if (assistantEvent.type === 'toolcall_delta') {
      const block = assistantEvent.partial.content[assistantEvent.contentIndex];
      if (block?.type !== 'toolCall') return;
      toolContexts.get(block.id)?.argsText?.append(assistantEvent.delta);
      return;
    }
    if (assistantEvent.type === 'toolcall_end') {
      const call = assistantEvent.toolCall;
      toolContexts.get(call.id)?.argsText?.close();
      const segment = segments.find(
        (item) => item.kind === 'tool' && item.toolCallId === call.id,
      );
      if (segment) {
        segment.toolName = call.name;
        segment.args = call.arguments;
      } else {
        segments.push({
          kind: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        });
      }
      return;
    }
    if (assistantEvent.type === 'done') {
      onUsage?.({
        inputTokens: assistantEvent.message.usage.input,
        outputTokens: assistantEvent.message.usage.output,
      });
    }
    return;
  }
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    onUsage?.({
      inputTokens: event.message.usage.input,
      outputTokens: event.message.usage.output,
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    const textParts: string[] = [];
    const images: Array<{ data: string; mimeType: string }> = [];
    for (const block of event.result.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        images.push({ data: block.data, mimeType: block.mimeType });
      }
    }
    const output = textParts.join('\n');
    const isError = event.isError || event.result.details?.isError === true;
    const ctx = toolContexts.get(event.toolCallId);
    if (ctx?.controller) {
      ctx.controller.setResponse(
        new ToolResponse({
          result: output,
          isError,
        }),
      );
    }
    const segment = segments.find(
      (item) => item.kind === 'tool' && item.toolCallId === event.toolCallId,
    );
    if (segment) {
      segment.result = output;
      segment.isError = isError;
      if (images.length > 0) {
        segment.images = images;
        for (const image of images) {
          controller?.appendFile({
            type: 'file',
            data: image.data,
            mimeType: image.mimeType,
          });
        }
      }
    } else {
      segments.push({
        kind: 'tool',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: output,
        isError,
        ...(images.length > 0 ? { images } : {}),
      });
      for (const image of images) {
        controller?.appendFile({
          type: 'file',
          data: image.data,
          mimeType: image.mimeType,
        });
      }
    }
    return;
  }
  if (event.type === 'agent_end') {
    if (!event.willRetry) {
      onAgentEnd?.();
    }
  }
}

// Serializes thread.json writes per process; concurrent persistTurn calls
// would otherwise race the temp-file rename and throw ENOENT.
let persistQueue: Promise<void> = Promise.resolve();

function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const run = persistQueue.then(task, task);
  persistQueue = run.catch(() => {});
  return run;
}

async function persistTurn(
  existingMessages: UIMessage[],
  segments: TurnSegment[],
  deps: ServerDeps,
  extraAssistantMetadata?: { replyToAgentId?: string },
): Promise<void> {
  // Persist the full thread as sent by the client (it already includes the
  // new user message) merged with anything stored that the client missed.
  const stored = await loadThread(deps.homeDir);
  const storedIds = new Set(
    stored.map((m) => m.id).filter((id): id is string => Boolean(id)),
  );
  const incoming = existingMessages
    .filter((m) => !m.id || !storedIds.has(m.id))
    .map((m) => (m.id ? m : { ...m, id: crypto.randomUUID() }));

  // Stable per-turn id derived from the triggering user message, so
  // incremental and final persists of one turn share the same marker.
  // Re-persisting an in-progress turn must replace, not append, its prior
  // partial assistant messages; otherwise each persist duplicates the turn.
  const lastUser = [...existingMessages]
    .reverse()
    .find((m) => m.role === 'user');
  const turnId = lastUser?.id ? `turn-${lastUser.id}` : undefined;

  // Metadata applied to every assistant message built from segments.
  const assistantMetadata: Record<string, unknown> | undefined = (() => {
    const replyToAgentId =
      typeof extraAssistantMetadata?.replyToAgentId === 'string' &&
      extraAssistantMetadata.replyToAgentId !== 'unknown' &&
      extraAssistantMetadata.replyToAgentId.length > 0
        ? extraAssistantMetadata.replyToAgentId
        : undefined;
    if (!turnId && !replyToAgentId) return undefined;
    return {
      ...(turnId ? { turnId } : {}),
      ...(replyToAgentId ? { replyToAgentId } : {}),
    };
  })();

  // Drop stored assistant messages from a prior partial persist of this
  // same turn before appending the freshly rebuilt ones.
  const messages = turnId
    ? [
        ...stored.filter((m) => m.metadata?.turnId !== turnId),
        ...incoming.filter((m) => m.metadata?.turnId !== turnId),
      ]
    : [...stored, ...incoming];

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
        current = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          ...(assistantMetadata ? { metadata: assistantMetadata } : {}),
        };
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
        current = {
          id: crypto.randomUUID(),
          role: 'assistant',
          ...(assistantMetadata ? { metadata: assistantMetadata } : {}),
        };
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
      if (seg.images?.length) {
        for (const img of seg.images) {
          parts.push({
            type: 'image',
            image: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType,
          });
        }
      }
      current.parts = parts;
    }
  }
  flush();
  await saveThread(deps.homeDir, messages);
  deps.onMessagesPersisted?.(messages);
}

export async function sendAgentMessageHttp(
  toAgentId: string,
  message: string,
  homeDir?: string,
  replyDepth = 0,
  taskId?: string,
): Promise<string> {
  const fromAgentId = process.env.AGENT_ID ?? 'unknown';
  const port = await findPortFor(toAgentId);
  if (!port) {
    return `Agent ${toAgentId} is unreachable (not running?).`;
  }

  const resolvedTaskId = taskId ?? crypto.randomUUID();

  try {
    const res = await fetch(`http://localhost:${port}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromAgentId,
        taskId: resolvedTaskId,
        message,
        replyTo: fromAgentId,
        // Depth tags the reply chain so the receiver can stop at the cap.
        inReplyTo: fromAgentId,
        replyDepth,
      }),
    });

    if (res.status === 409) {
      // Queue for later delivery instead of failing.
      if (homeDir) {
        await appendOutbox(homeDir, {
          toAgentId,
          message,
          inReplyTo: fromAgentId,
          ts: Date.now(),
          taskId: resolvedTaskId,
        });
        return `Agent ${toAgentId} is busy; your message was queued and will be delivered when they are free.`;
      }
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
