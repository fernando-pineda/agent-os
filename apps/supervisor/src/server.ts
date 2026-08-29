import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import type { AgentAvatar, AgentInfo, McpServerConfig } from '@agent-os/core';
import { createGroup, deleteGroup, loadGroups } from './groups.js';
import { installLaunchdAgent, uninstallLaunchdAgent } from './launchd.js';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  probeMcpStatuses,
  updateMcpServer,
} from './mcps.js';
import {
  isConfigured,
  listModels,
  onboard,
  readGlobalConfig,
  updateGlobalConfig,
} from './onboarding.js';
import type { CreateAgentInput, Registry } from './registry.js';
import {
  createAgent,
  deleteAgent,
  getAgentPort,
  listAgentConfigs,
  readAgentConfig,
  startAgent,
  stopAgent,
  updateAgentConfig,
} from './registry.js';
import type { StatusTracker } from './status.js';

const port = Number(process.env.PORT ?? 8787);

export function startServer(
  registry: Registry,
  statusTracker: StatusTracker,
): void {
  const server = createServer(async (req, res) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const sendCors = (): void => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    };
    sendCors();
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await handle(req, res, url, registry, statusTracker);
    } catch (err) {
      console.error('Request error', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: (err as Error).message ?? String(err) }),
        );
      }
    }
  });

  server.listen(port, () => {
    console.log(`Supervisor listening on http://localhost:${port}`);
  });

  process.on('SIGTERM', () => shutdown(server, statusTracker));
  process.on('SIGINT', () => shutdown(server, statusTracker));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: Registry,
  statusTracker: StatusTracker,
): Promise<void> {
  const pathname = url.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/onboarding/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ configured: await isConfigured() }));
    return;
  }

  if (pathname === '/api/onboarding' && req.method === 'POST') {
    const body = await readJson(req);
    await onboard(
      body as { provider: 'fireworks'; apiKey: string; defaultModel: string },
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const config = await readGlobalConfig();
    if (!config) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not configured' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        provider: config.provider,
        apiKey: maskApiKey(config.apiKey),
        defaultModel: config.defaultModel,
        ...(config.reminders ? { reminders: config.reminders } : {}),
      }),
    );
    return;
  }

  if (pathname === '/api/config' && req.method === 'PATCH') {
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: {
      apiKey?: string;
      defaultModel?: string;
      reminders?: string[];
    } = {};
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;
    if (typeof body.defaultModel === 'string')
      patch.defaultModel = body.defaultModel;
    if (body.reminders !== undefined) {
      const remindersError = validateStringArray(body.reminders, 'reminders');
      if (remindersError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: remindersError }));
        return;
      }
      patch.reminders = body.reminders as string[];
    }
    const updated = await updateGlobalConfig(patch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        provider: updated.provider,
        apiKey: maskApiKey(updated.apiKey),
        defaultModel: updated.defaultModel,
        ...(updated.reminders ? { reminders: updated.reminders } : {}),
      }),
    );
    return;
  }

  if (pathname === '/api/mcp' && req.method === 'GET') {
    const servers = await listMcpServers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers }));
    return;
  }

  if (pathname === '/api/mcp/status' && req.method === 'GET') {
    const result = await probeMcpStatuses();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/mcp' && req.method === 'POST') {
    const body = (await readJson(req)) as Record<string, unknown>;
    const validation = validateMcpServer(body);
    if (validation.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }
    try {
      const created = await createMcpServer(validation.server);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
    } catch (err) {
      if (err instanceof Error && err.message === 'duplicate') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'A server with that name already exists' }),
        );
        return;
      }
      throw err;
    }
    return;
  }

  const matchMcp = /^\/api\/mcp\/([^/]+)$/.exec(pathname);
  if (matchMcp && req.method === 'PATCH') {
    const name = decodeURIComponent(matchMcp[1]!);
    const body = (await readJson(req)) as Record<string, unknown>;
    const validation = validateMcpServer(body);
    if (validation.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }
    try {
      const updated = await updateMcpServer(name, validation.server);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      if (err instanceof Error && err.message === 'duplicate') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'A server with that name already exists' }),
        );
        return;
      }
      throw err;
    }
    return;
  }

  if (matchMcp && req.method === 'DELETE') {
    const name = decodeURIComponent(matchMcp[1]!);
    const removed = await deleteMcpServer(name);
    if (!removed) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const result = await listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/groups' && req.method === 'GET') {
    const groups = await loadGroups();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ groups }));
    return;
  }

  if (pathname === '/api/groups' && req.method === 'POST') {
    const body = (await readJson(req)) as { name?: string };
    const name = body.name?.trim();
    if (!name) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name is required' }));
      return;
    }
    const result = await createGroup(name);
    if (result === 'exists') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Group already exists' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const matchGroup = /^\/api\/groups\/([^/]+)$/.exec(pathname);
  if (matchGroup && req.method === 'DELETE') {
    const name = decodeURIComponent(matchGroup[1]!);
    await deleteGroup(name);
    const configs = await listAgentConfigs();
    for (const config of configs) {
      if (config.group === name) {
        await updateAgentConfig(config.id, { group: '' });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/agents' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: statusTracker.getAgents() }));
    return;
  }

  if (pathname === '/api/agents' && req.method === 'POST') {
    const raw = await readJson(req);
    const body = raw as Record<string, unknown>;
    const input: CreateAgentInput = { name: String(body.name ?? '') };
    if (typeof body.group === 'string') input.group = body.group;
    if (typeof body.workspace === 'string') input.workspace = body.workspace;
    if (typeof body.role === 'string') input.role = body.role;
    if (typeof body.model === 'string') input.model = body.model;
    if (typeof body.sandboxed === 'boolean') input.sandboxed = body.sandboxed;
    if (typeof body.instructions === 'string')
      input.instructions = body.instructions;
    if (body.avatar !== undefined) {
      const avatar = validateAvatar(body.avatar);
      if (!avatar) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid avatar' }));
        return;
      }
      input.avatar = avatar;
    } else {
      // Avatar is required on create; any character is accepted.
      input.avatar = {
        character: AGENT_CHARACTERS[0]!,
        color: '#27272a',
      };
    }
    if (body.plugins !== undefined) {
      const pluginsError = await validatePluginNames(body.plugins);
      if (pluginsError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: pluginsError }));
        return;
      }
      input.plugins = body.plugins as string[];
    }
    if (body.reminders !== undefined) {
      const remindersError = validateStringArray(body.reminders, 'reminders');
      if (remindersError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: remindersError }));
        return;
      }
      input.reminders = body.reminders as string[];
    }
    const config = await readGlobalConfig();
    const result = await createAgent(
      registry,
      input,
      config?.defaultModel ?? 'unknown-model',
    );
    if (result.error) {
      const status = result.needsSudo ? 422 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.agent));
    return;
  }

  const matchAgentId = /^\/api\/agents\/([^/]+)$/.exec(pathname);
  if (matchAgentId && matchAgentId[1] !== 'events' && req.method === 'PATCH') {
    const id = decodeURIComponent(matchAgentId[1]!);
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: Parameters<typeof updateAgentConfig>[1] = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.group === 'string') patch.group = body.group;
    if (typeof body.role === 'string') patch.role = body.role;
    if (typeof body.instructions === 'string')
      patch.instructions = body.instructions;
    if (typeof body.model === 'string') patch.model = body.model;
    if (typeof body.workspace === 'string') patch.workspace = body.workspace;
    if (typeof body.sandboxed === 'boolean') patch.sandboxed = body.sandboxed;
    if (body.avatar !== undefined) {
      const avatar = validateAvatar(body.avatar);
      if (avatar) patch.avatar = avatar;
    }
    if (body.plugins !== undefined) {
      const pluginsError = await validatePluginNames(body.plugins);
      if (pluginsError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: pluginsError }));
        return;
      }
      patch.plugins = body.plugins as string[];
    }
    if (body.reminders !== undefined) {
      const remindersError = validateStringArray(body.reminders, 'reminders');
      if (remindersError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: remindersError }));
        return;
      }
      patch.reminders = body.reminders as string[];
    }
    try {
      const updated = await updateAgentConfig(id, patch);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      statusTracker.refreshAgent(updated);
      // If plugins changed and the agent is running, hot-reload its MCPs.
      if (patch.plugins !== undefined) {
        const port = getAgentPort(registry, id);
        if (port) {
          fetch(`http://localhost:${port}/plugins/reload`, { method: 'POST' })
            .then(async (r) => {
              if (!r.ok)
                console.warn(`plugins/reload ${id} returned ${r.status}`);
            })
            .catch((err) =>
              console.warn(
                `plugins/reload ${id} failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    } catch (err) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
  }

  if (matchAgentId && matchAgentId[1] !== 'events' && req.method === 'DELETE') {
    const id = decodeURIComponent(matchAgentId[1]!);
    const config = await readAgentConfig(id);
    if (!config) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    if (body.confirm !== config.name) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Deletion requires confirm: "${config.name}"`,
        }),
      );
      return;
    }
    await deleteAgent(registry, id);
    statusTracker.removeAgent(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id }));
    return;
  }

  const matchStartStop = /^\/api\/agents\/([^/]+)\/(start|stop)$/.exec(
    pathname,
  );
  if (matchStartStop && req.method === 'POST') {
    const id = decodeURIComponent(matchStartStop[1]!);
    const action = matchStartStop[2]!;
    const result =
      action === 'start'
        ? await startAgent(registry, id)
        : await stopAgent(registry, id);
    statusTracker.updateStatus(id, action === 'stop' ? 'stopped' : 'starting');
    if (!result) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/agents/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (data: AgentInfo[]): void => {
      res.write(`data: ${JSON.stringify({ agents: data })}\n\n`);
    };
    send(statusTracker.getAgents());
    const unsubscribe = statusTracker.onChange(() => {
      send(statusTracker.getAgents());
    });
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  const matchAgentAbort = /^\/api\/agents\/([^/]+)\/abort$/.exec(pathname);
  if (matchAgentAbort && req.method === 'POST') {
    const id = decodeURIComponent(matchAgentAbort[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(`http://localhost:${agentPort}/abort`, {
        method: 'POST',
      });
      const body = await response.text();
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return;
  }

  const matchAgentChat = /^\/api\/agents\/([^/]+)\/chat$/.exec(pathname);
  if (matchAgentChat && req.method === 'POST') {
    const id = decodeURIComponent(matchAgentChat[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    const contentType = req.headers['content-type'] ?? 'application/json';
    const body = await readBuffer(req);
    try {
      const response = await fetch(`http://localhost:${agentPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      if (!response.ok) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent returned an error' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type':
          response.headers.get('content-type') ?? 'application/json',
      });
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchAgentMessages = /^\/api\/agents\/([^/]+)\/messages$/.exec(
    pathname,
  );
  if (matchAgentMessages && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentMessages[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(`http://localhost:${agentPort}/messages`);
      if (!response.ok) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent returned an error' }));
        return;
      }
      const body = await response.text();
      res.writeHead(200, {
        'Content-Type':
          response.headers.get('content-type') ?? 'application/json',
      });
      res.end(body);
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchAgentUsage = /^\/api\/agents\/([^/]+)\/usage$/.exec(pathname);
  if (matchAgentUsage && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentUsage[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(`http://localhost:${agentPort}/usage`);
      const body = await response.text();
      res.writeHead(response.ok ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(body);
      return;
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ inputTokens: 0, outputTokens: 0 }));
      return;
    }
  }

  // Automations proxy: forwards to the agent's own server for CRUD + run.
  const matchAutomations = /^\/api\/agents\/([^/]+)\/automations$/.exec(
    pathname,
  );
  if (matchAutomations && (req.method === 'GET' || req.method === 'POST')) {
    const id = decodeURIComponent(matchAutomations[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    const contentType = req.headers['content-type'] ?? 'application/json';
    const body = await readBuffer(req);
    const init: RequestInit = {
      method: req.method,
      headers: { 'Content-Type': contentType },
    };
    if (req.method === 'POST') init.body = body;
    try {
      const response = await fetch(
        `http://localhost:${agentPort}/automations`,
        init,
      );
      const respBody = await response.text();
      res.writeHead(response.ok ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(respBody);
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchAutomationItem =
    /^\/api\/agents\/([^/]+)\/automations\/([^/]+)$/.exec(pathname);
  if (
    matchAutomationItem &&
    (req.method === 'GET' || req.method === 'PATCH' || req.method === 'DELETE')
  ) {
    const id = decodeURIComponent(matchAutomationItem[1]!);
    const automationId = decodeURIComponent(matchAutomationItem[2]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    const contentType = req.headers['content-type'] ?? 'application/json';
    const body = await readBuffer(req);
    const init: RequestInit = {
      method: req.method,
      headers: { 'Content-Type': contentType },
    };
    if (req.method !== 'GET') init.body = body;
    try {
      const response = await fetch(
        `http://localhost:${agentPort}/automations/${encodeURIComponent(automationId)}`,
        init,
      );
      const respBody = await response.text();
      res.writeHead(response.ok ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(respBody);
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchAutomationRun =
    /^\/api\/agents\/([^/]+)\/automations\/([^/]+)\/run$/.exec(pathname);
  if (matchAutomationRun && req.method === 'POST') {
    const id = decodeURIComponent(matchAutomationRun[1]!);
    const automationId = decodeURIComponent(matchAutomationRun[2]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(
        `http://localhost:${agentPort}/automations/${encodeURIComponent(automationId)}/run`,
        { method: 'POST' },
      );
      const respBody = await response.text();
      res.writeHead(response.ok ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(respBody);
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchAgentTools = /^\/api\/agents\/([^/]+)\/tools$/.exec(pathname);
  if (matchAgentTools && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentTools[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(`http://localhost:${agentPort}/tools`);
      const respBody = await response.text();
      res.writeHead(response.ok ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(respBody);
      return;
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is unreachable' }));
      return;
    }
  }

  const matchLaunchd =
    /^\/api\/agents\/([^/]+)\/launchd\/(install|uninstall)$/.exec(pathname);
  if (matchLaunchd && req.method === 'POST') {
    const id = decodeURIComponent(matchLaunchd[1]!);
    const action = matchLaunchd[2]!;
    const result =
      action === 'install'
        ? await installLaunchdAgent(id)
        : await uninstallLaunchdAgent(id);
    res.writeHead(result.ok ? 200 : 500, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function maskApiKey(key: string): string {
  if (key.length <= 4) {
    return '•'.repeat(key.length);
  }
  return `••••${key.slice(-4)}`;
}

const AGENT_CHARACTERS = [
  'layer-blue-pyramid-character',
  'layer-dark-bat-character',
  'layer-green-cactus-character',
  'layer-orange-sun-character',
  'layer-pink-cloud-character',
  'layer-purple-donut-character',
  'layer-purple-slime-character',
  'layer-teal-blob-character',
  'layer-yellow-star-character',
];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function validatePluginNames(value: unknown): Promise<string | null> {
  if (!Array.isArray(value)) return 'plugins must be an array of strings';
  const known = new Set((await listMcpServers()).map((s) => s.name));
  for (const name of value) {
    if (typeof name !== 'string') return 'plugins must be an array of strings';
    if (!known.has(name)) return `Unknown plugin: ${name}`;
  }
  return null;
}

function validateStringArray(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  for (const item of value) {
    if (typeof item !== 'string') return `${field} must be an array of strings`;
  }
  return null;
}

function validateAvatar(value: unknown): AgentAvatar | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { character?: unknown; color?: unknown };
  if (typeof candidate.character !== 'string') return null;
  if (typeof candidate.color !== 'string') return null;
  if (!AGENT_CHARACTERS.includes(candidate.character)) return null;
  if (!HEX_COLOR_RE.test(candidate.color)) return null;
  return { character: candidate.character, color: candidate.color };
}

interface McpValidation {
  server: McpServerConfig;
  error?: string;
}

function validateMcpServer(body: Record<string, unknown>): McpValidation {
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      server: { name: '', transport: 'stdio' },
      error: 'name is required',
    };
  }
  const transport = body.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    return {
      server: { name: '', transport: 'stdio' },
      error: "transport must be 'stdio' or 'http'",
    };
  }
  const server: McpServerConfig = { name: name.trim(), transport };
  if (transport === 'stdio') {
    const command = body.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        server: { name: '', transport: 'stdio' },
        error: 'command is required for stdio transport',
      };
    }
    server.command = command.trim();
    if (Array.isArray(body.args)) {
      server.args = (body.args as unknown[]).filter(
        (a): a is string => typeof a === 'string',
      );
    }
    if (
      typeof body.env === 'object' &&
      body.env !== null &&
      !Array.isArray(body.env)
    ) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        body.env as Record<string, unknown>,
      )) {
        if (typeof v === 'string') env[k] = v;
      }
      server.env = env;
    }
  } else {
    const url = body.url;
    if (typeof url !== 'string' || url.trim() === '') {
      return {
        server: { name: '', transport: 'http' },
        error: 'url is required for http transport',
      };
    }
    server.url = url.trim();
    if (
      typeof body.headers === 'object' &&
      body.headers !== null &&
      !Array.isArray(body.headers)
    ) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        body.headers as Record<string, unknown>,
      )) {
        if (typeof v === 'string') headers[k] = v;
      }
      server.headers = headers;
    }
  }
  return { server };
}

async function shutdown(
  server: ReturnType<typeof createServer>,
  statusTracker: StatusTracker,
): Promise<void> {
  await statusTracker.close();
  server.close(() => {
    process.exit(0);
  });
}
