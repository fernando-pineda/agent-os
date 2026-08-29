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
import { Cron } from 'croner';
import type { Automation, AutomationScheduler } from './automations.js';
import { loadMemoryIndex } from './compact.js';
import {
  readAgentConfigFresh,
  readAgentReminders,
  readGlobalReminders,
} from './config.js';
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
  provider?: 'fireworks' | 'zai';
  llm: LLMClient;
  tools: Tool[];
  status: AgentStatus;
  currentTaskId?: string;
  onStatusChange: (status: AgentStatus) => void;
  buildContext: (signal?: AbortSignal) => ToolContext;
  sendAgentMessage: (
    toAgentId: string,
    message: string,
    opts?: { replyDepth?: number },
  ) => Promise<string>;
  onMessagesPersisted?: (messages: UIMessage[]) => void;
  scheduler?: AutomationScheduler;
  onPluginsReload?: () => Promise<Tool[]>;
}

export interface AgentServer {
  start: () => Promise<number>;
  stop: () => Promise<void>;
  setStatus: (status: AgentStatus) => void;
  setCurrentTaskId: (taskId: string | undefined) => void;
  isBusy: () => boolean;
  setScheduler: (scheduler: AutomationScheduler) => void;
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

// Max hops in an agent-to-agent reply chain before the receiver is told to stop.
const MAX_AGENT_REPLY_DEPTH = 6;
// Turn reminder appended to inbound replies so the agent weighs ending it.
const REPLY_TURN_REMINDER =
  '[system: this is a reply in an ongoing exchange. If it still carries a task or question, answer it and send the answer back with message_agent as usual. Only skip message_agent when it is purely social (farewell, acknowledgment, thanks) with nothing left to do.]';

export function createAgentServer(deps: ServerDeps): AgentServer {
  let status = deps.status;
  let currentTaskId = deps.currentTaskId;
  let running = false;
  let runningController: AbortController | undefined;
  let scheduler: AutomationScheduler | undefined = deps.scheduler;
  let tools = deps.tools;
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
          { ...deps, onMessagesPersisted: notifyMessages },
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
          { ...deps, onMessagesPersisted: notifyMessages },
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
        const list = tools.map((t) => ({
          name: t.spec.name,
          description: t.spec.description,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tools: list }));
        return;
      }

      // POST /abort - cancel the currently running turn
      if (method === 'POST' && url === '/abort') {
        if (!running || !runningController) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'No run in progress' }));
          return;
        }
        runningController.abort();
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
          tools = next;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ ok: true, tools: next.map((t) => t.spec.name) }),
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
      runningController?.abort();
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
          const globalReminders = await readGlobalReminders();
          const agentReminders = await readAgentReminders(serverDeps.agentId);
          const freshAgent = await readAgentConfigFresh(serverDeps.agentId);
          const agentName = freshAgent?.name;
          const agentRole = freshAgent?.role ?? serverDeps.agent.role;
          const agentInstructions =
            freshAgent?.instructions ?? serverDeps.agent.instructions;
          const reminders = [
            ...(globalReminders ?? []),
            ...(agentReminders ?? []),
          ];
          // Persist incrementally so a reload mid-run keeps the turn so far.
          const persistPartial = (): Promise<void> =>
            enqueuePersist(() => persistTurn(messages, segments, serverDeps));
          await runAgentLoop({
            llm: serverDeps.llm,
            tools,
            model: serverDeps.model,
            ...(serverDeps.provider ? { provider: serverDeps.provider } : {}),
            messages: chatMessages,
            agentId: serverDeps.agentId,
            ...(agentName ? { agentName } : {}),
            ...(agentRole ? { role: agentRole } : {}),
            ...(agentInstructions ? { instructions: agentInstructions } : {}),
            ...(memoryIndex ? { memoryIndex } : {}),
            ...(reminders.length > 0 ? { reminders } : {}),
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
              // Persist incrementally on each completed segment boundary.
              if (
                event.type === 'tool-call' ||
                event.type === 'tool-result' ||
                event.type === 'done'
              ) {
                void persistPartial();
              }
            },
          });
          await enqueuePersist(() =>
            persistTurn(messages, segments, serverDeps),
          );
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
      inReplyTo?: string;
      replyDepth: number;
    },
    serverDeps: ServerDeps,
    controls: RunControls,
  ): Promise<{ accepted: true; id: string }> {
    controls.setCurrentTaskId(body.taskId);
    controls.setStatus('busy');
    controls.markRunning(true);
    runningController = new AbortController();

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
        content: `[agent-os:inbox from=${body.fromAgentId}${body.inReplyTo ? ' reply' : ''}] ${prefix} ${body.fromAgentId}: ${body.message}${closingNote}${turnReminder}`,
      },
    ];

    const controller = runningController;

    void processInbox(
      {
        fromAgentId: body.fromAgentId,
        replyDepth: depth,
        atCap,
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
    },
    chatMessages: ChatMessage[],
    serverDeps: ServerDeps,
    controls: RunControls,
    controller: AbortController,
  ): Promise<void> {
    const toolContexts = new Map<string, ToolCallContext>();
    const segments: TurnSegment[] = [];

    try {
      const globalReminders = await readGlobalReminders();
      const agentReminders = await readAgentReminders(serverDeps.agentId);
      const freshAgent = await readAgentConfigFresh(serverDeps.agentId);
      const agentName = freshAgent?.name;
      const agentRole = freshAgent?.role ?? serverDeps.agent.role;
      const agentInstructions =
        freshAgent?.instructions ?? serverDeps.agent.instructions;
      const reminders = [...(globalReminders ?? []), ...(agentReminders ?? [])];
      await runAgentLoop({
        llm: serverDeps.llm,
        tools,
        model: serverDeps.model,
        ...(serverDeps.provider ? { provider: serverDeps.provider } : {}),
        messages: chatMessages,
        agentId: serverDeps.agentId,
        ...(agentName ? { agentName } : {}),
        ...(agentRole ? { role: agentRole } : {}),
        ...(agentInstructions ? { instructions: agentInstructions } : {}),
        ...(reminders.length > 0 ? { reminders } : {}),
        buildContext: (signal) => {
          const ctx = serverDeps.buildContext(signal);
          const overridden: ToolContext = {
            ...ctx,
            replyDepth: body.replyDepth,
          };
          if (body.atCap) {
            overridden.sendAgentMessage = async () =>
              'Reply limit reached for this exchange; not sent. Respond in plain text.';
          }
          return overridden;
        },
        signal: controller.signal,
        onEvent: (event: LoopEvent) => {
          handleStreamEvent(event, undefined, toolContexts, segments);
        },
      });
      // Auto-deliver: if the turn did real work (used a non-messaging tool) and
      // ended with text but never called message_agent back, that answer would
      // be lost (plain text is not delivered between agents). Forward it to the
      // sender. Skip when nothing but text was produced (a social close-out is
      // local, not a reply) and at the reply cap, where the point is to stop.
      if (!body.atCap) {
        const calledBack = segments.some(
          (s) => s.kind === 'tool' && s.toolName === 'message_agent',
        );
        const didWork = segments.some(
          (s) => s.kind === 'tool' && s.toolName !== 'message_agent',
        );
        const finalText = [...segments]
          .reverse()
          .find((s) => s.kind === 'text' && s.text && s.text.trim())
          ?.text?.trim();
        if (!calledBack && didWork && finalText) {
          const nextDepth = body.replyDepth + 1;
          const delivered = await serverDeps.sendAgentMessage(
            body.fromAgentId,
            finalText,
            { replyDepth: nextDepth },
          );
          console.log(`Auto-delivered inbox reply to ${body.fromAgentId}`, {
            depth: nextDepth,
            delivered,
          });
          segments.push({
            kind: 'tool',
            toolCallId: `auto-${crypto.randomUUID()}`,
            toolName: 'message_agent',
            args: { toAgentId: body.fromAgentId, message: finalText },
            result: delivered,
          });
        }
      }
      // Persist the inbound message so the UI can surface it and the model
      // sees it in context after restarts. Replies go out via message_agent,
      // not an auto-forward, so no replyToAgentId is set here.
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
          ...(body.inReplyTo ? { reply: true } : {}),
        },
      };
      await persistTurn([inbound], segments, serverDeps);
    } catch (err) {
      console.error('Inbox loop error', err);
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
): Promise<string> {
  const fromAgentId = process.env.AGENT_ID ?? 'unknown';
  const port = await findPortFor(toAgentId);
  if (!port) {
    return `Agent ${toAgentId} is unreachable (not running?).`;
  }

  try {
    const res = await fetch(`http://localhost:${port}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromAgentId,
        taskId: crypto.randomUUID(),
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
