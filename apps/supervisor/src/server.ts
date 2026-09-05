import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { URL } from 'node:url';
import {
  AGENT_AVATAR_DEFAULT_COLOR,
  AGENT_CHARACTERS,
  type AgentAvatar,
  type AgentInfo,
  type McpServerConfig,
} from '@agent-os/core';
import { createGroup, deleteGroup, loadGroups } from './groups.js';
import {
  handleHostDesktopRequest,
  handleHostDesktopUpgrade,
  isAllowedHostDesktopRequest,
  isHostDesktopAgentPath,
  isHostDesktopPath,
  setHostDesktopCorsHeaders,
} from './host-desktop.js';
import { installLaunchdAgent, uninstallLaunchdAgent } from './launchd.js';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  probeMcpStatuses,
  updateMcpServer,
} from './mcps.js';
import {
  ensureConfig,
  listModels,
  readGlobalConfig,
  updateGlobalConfig,
} from './onboarding.js';
import type {
  AgentConfigPatch,
  CreateAgentInput,
  Registry,
} from './registry.js';
import {
  createAgent,
  deleteAgent,
  getAgentPort,
  listAgentConfigs,
  loadRegistry,
  readAgentConfig,
  startAgent,
  stopAgent,
  updateAgentConfig,
} from './registry.js';
import type { StatusTracker } from './status.js';
import type { SubagentConfig } from './subagents.js';
import {
  createSubagent,
  deleteSubagent,
  listSubagents,
  updateSubagent,
} from './subagents.js';

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
    if (isHostDesktopPath(url.pathname)) {
      if (!isAllowedHostDesktopRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'Host desktop access is not allowed' }),
        );
        return;
      }
      setHostDesktopCorsHeaders(res);
    } else {
      sendCors();
    }
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

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    if (isHostDesktopAgentPath(reqUrl.pathname)) {
      void handleHostDesktopUpgrade(
        req,
        socket as import('node:net').Socket,
        head,
      ).catch((err: Error): void => {
        console.error('Host desktop upgrade error', err.message);
        socket.destroy();
      });
      return;
    }
    void handleDesktopUpgrade(
      req,
      socket as import('node:net').Socket,
      head,
      registry,
    ).catch((err: Error): void => {
      console.error('Desktop upgrade error', err);
      socket.destroy();
    });
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

  if (isHostDesktopPath(pathname)) {
    const handled = await handleHostDesktopRequest(req, res, pathname);
    if (handled) return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/onboarding/status' && req.method === 'GET') {
    // Pi owns provider credentials. agent-os is always ready.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ configured: true }));
    return;
  }

  if (pathname === '/api/onboarding' && req.method === 'POST') {
    // No-op, kept for backward compatibility with older web clients.
    await ensureConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const config = (await readGlobalConfig()) ?? (await ensureConfig());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
        ...(config.reminders ? { reminders: config.reminders } : {}),
      }),
    );
    return;
  }

  if (pathname === '/api/config' && req.method === 'PATCH') {
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: {
      defaultModel?: string;
      reminders?: string[];
    } = {};
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
        ...(updated.defaultModel ? { defaultModel: updated.defaultModel } : {}),
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

  if (pathname === '/api/subagents' && req.method === 'GET') {
    const subagents = await listSubagents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subagents }));
    return;
  }

  if (pathname === '/api/subagents' && req.method === 'POST') {
    const body = (await readJson(req)) as SubagentBody;
    const validation = validateSubagent(body);
    if (validation.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }
    try {
      const created = await createSubagent(validation.config);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
    } catch (err) {
      if (err instanceof Error && err.message === 'duplicate') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'A subagent with that name already exists' }),
        );
        return;
      }
      throw err;
    }
    return;
  }

  const matchSubagent = /^\/api\/subagents\/([^/]+)$/.exec(pathname);
  if (matchSubagent && req.method === 'PATCH') {
    const name = decodeURIComponent(matchSubagent[1]!);
    const body = (await readJson(req)) as SubagentBody;
    const validation = validateSubagentPatch(body);
    if (validation.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }
    try {
      const updated = await updateSubagent(name, validation.patch);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Subagent not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      if (err instanceof Error && err.message === 'duplicate') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'A subagent with that name already exists' }),
        );
        return;
      }
      throw err;
    }
    return;
  }

  if (matchSubagent && req.method === 'DELETE') {
    const name = decodeURIComponent(matchSubagent[1]!);
    const removed = await deleteSubagent(name);
    if (!removed) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Subagent not found' }));
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
    if (body.sandboxType === 'host' || body.sandboxType === 'docker-desktop') {
      input.sandboxType = body.sandboxType;
    }
    if (typeof body.kasmImage === 'string') input.kasmImage = body.kasmImage;
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
        color: AGENT_AVATAR_DEFAULT_COLOR,
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
    if (body.subagents !== undefined) {
      const subagentsError = validateStringArray(body.subagents, 'subagents');
      if (subagentsError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: subagentsError }));
        return;
      }
      input.subagents = body.subagents as string[];
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    // Push the new agent to SSE subscribers immediately.
    if (result.agent) {
      const createdConfig = await readAgentConfig(result.agent.id);
      if (createdConfig) await statusTracker.refreshAgent(createdConfig);
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.agent));
    return;
  }

  const matchAgentId = /^\/api\/agents\/([^/]+)$/.exec(pathname);
  if (matchAgentId && matchAgentId[1] !== 'events' && req.method === 'PATCH') {
    const id = decodeURIComponent(matchAgentId[1]!);
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: AgentConfigPatch = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.group === 'string') patch.group = body.group;
    if (typeof body.role === 'string') patch.role = body.role;
    if (typeof body.instructions === 'string')
      patch.instructions = body.instructions;
    if (typeof body.model === 'string') patch.model = body.model;
    if (typeof body.workspace === 'string') patch.workspace = body.workspace;
    if (typeof body.sandboxed === 'boolean') patch.sandboxed = body.sandboxed;
    if (body.sandboxType === 'host' || body.sandboxType === 'docker-desktop') {
      patch.sandboxType = body.sandboxType;
    }
    if (typeof body.kasmImage === 'string') patch.kasmImage = body.kasmImage;
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
    if (body.subagents !== undefined) {
      const subagentsError = validateStringArray(body.subagents, 'subagents');
      if (subagentsError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: subagentsError }));
        return;
      }
      patch.subagents = body.subagents as string[];
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
      await statusTracker.refreshAgent(updated);
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
    const config = await readGlobalConfig();
    const defaultModel = config?.defaultModel ?? 'unknown-model';
    const result =
      action === 'start'
        ? await startAgent(registry, id, defaultModel)
        : await stopAgent(registry, id, defaultModel);
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

  const matchAgentDesktop = /^\/api\/agents\/([^/]+)\/desktop$/.exec(pathname);
  if (matchAgentDesktop && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentDesktop[1]!);
    const entry = registry.agents.find((agent) => agent.id === id);
    if (!entry || entry.vncPort === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No desktop for this agent' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        url: `http://localhost:${port}/api/agents/${encodeURIComponent(id)}/desktop/proxy/`,
        port: entry.vncPort,
        status: entry.status === 'stopped' ? 'stopped' : 'running',
      }),
    );
    return;
  }

  const matchDesktopProxy =
    /^\/api\/agents\/([^/]+)\/desktop\/proxy\/?(.*)$/.exec(pathname);
  if (matchDesktopProxy) {
    const id = decodeURIComponent(matchDesktopProxy[1]!);
    const subPath = matchDesktopProxy[2] ?? '';
    const entry = registry.agents.find((agent) => agent.id === id);
    if (!entry || entry.vncPort === undefined || !entry.vncPassword) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No desktop for this agent' }));
      return;
    }
    const target = new URL(
      `https://127.0.0.1:${entry.vncPort}/${subPath}${url.search}`,
    );
    const authHeader = `Basic ${Buffer.from(`kasm_user:${entry.vncPassword}`).toString('base64')}`;
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (
        key.toLowerCase() === 'host' ||
        key.toLowerCase() === 'connection' ||
        key.toLowerCase() === 'authorization'
      )
        continue;
      if (typeof val === 'string') headers[key] = val;
    }
    headers['authorization'] = authHeader;
    headers['host'] = `localhost:${entry.vncPort}`;

    const proxyReq = httpsRequest(target, {
      method: req.method ?? 'GET',
      headers,
      rejectUnauthorized: false,
    });

    proxyReq.on('response', (proxyRes) => {
      const respHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (
          key.toLowerCase() === 'transfer-encoding' ||
          key.toLowerCase() === 'connection'
        )
          continue;
        if (typeof val === 'string') respHeaders[key] = val;
      }
      res.writeHead(proxyRes.statusCode ?? 200, respHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  const matchAgentMessagesStream =
    /^\/api\/agents\/([^/]+)\/messages\/stream$/.exec(pathname);
  if (matchAgentMessagesStream && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentMessagesStream[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const upstream = await fetch(
        `http://localhost:${agentPort}/messages/stream`,
      );
      if (!upstream.ok || !upstream.body) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent stream unavailable' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      };
      req.on('close', () => {
        void reader.cancel().catch(() => undefined);
      });
      await pump();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } else {
        res.end();
      }
    }
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

  const matchAgentSubagentsStream =
    /^\/api\/agents\/([^/]+)\/subagents\/stream$/.exec(pathname);
  if (matchAgentSubagentsStream && req.method === 'GET') {
    const id = decodeURIComponent(matchAgentSubagentsStream[1]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const upstream = await fetch(
        `http://localhost:${agentPort}/subagents/stream`,
      );
      if (!upstream.ok || !upstream.body) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent stream unavailable' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      };
      req.on('close', () => {
        void reader.cancel().catch(() => undefined);
      });
      await pump();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } else {
        res.end();
      }
    }
    return;
  }

  const matchAgentSubagentStop =
    /^\/api\/agents\/([^/]+)\/subagents\/([^/]+)\/stop$/.exec(pathname);
  if (matchAgentSubagentStop && req.method === 'POST') {
    const id = decodeURIComponent(matchAgentSubagentStop[1]!);
    const runId = decodeURIComponent(matchAgentSubagentStop[2]!);
    const agentPort = getAgentPort(registry, id);
    if (!agentPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    try {
      const response = await fetch(
        `http://localhost:${agentPort}/subagents/${runId}/stop`,
        { method: 'POST' },
      );
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

interface SubagentValidation {
  config: SubagentConfig;
  error?: string;
}

interface SubagentPatchValidation {
  patch: Partial<SubagentConfig>;
  error?: string;
}

type SubagentField = string | string[] | number | boolean | null;
type SubagentBody = Record<string, SubagentField>;

const SUBAGENT_NAME_RE = /^[a-z0-9-]{1,64}$/;

function validateSubagent(body: SubagentBody): SubagentValidation {
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return invalidSubagent('name is required');
  }
  const normalizedName = name.trim();
  if (!SUBAGENT_NAME_RE.test(normalizedName)) {
    return invalidSubagent(
      'name must be 1-64 characters using lowercase letters, numbers, and hyphens',
    );
  }

  const description = body.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return invalidSubagent('description is required');
  }
  const systemPrompt = body.systemPrompt;
  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
    return invalidSubagent('systemPrompt is required');
  }

  const config: SubagentConfig = {
    name: normalizedName,
    description,
    systemPrompt,
  };
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') {
      return invalidSubagent('model must be a string');
    }
    config.model = body.model;
  }
  if (body.tools !== undefined) {
    const tools = parseStringArray(body.tools);
    if (!tools) {
      return invalidSubagent('tools must be an array of strings');
    }
    config.tools = tools;
  }
  return { config };
}

function validateSubagentPatch(body: SubagentBody): SubagentPatchValidation {
  const patch: Partial<SubagentConfig> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return { patch, error: 'name is required' };
    }
    const name = body.name.trim();
    if (!SUBAGENT_NAME_RE.test(name)) {
      return {
        patch,
        error:
          'name must be 1-64 characters using lowercase letters, numbers, and hyphens',
      };
    }
    patch.name = name;
  }
  if (body.description !== undefined) {
    if (
      typeof body.description !== 'string' ||
      body.description.trim() === ''
    ) {
      return { patch, error: 'description is required' };
    }
    patch.description = body.description;
  }
  if (body.systemPrompt !== undefined) {
    if (
      typeof body.systemPrompt !== 'string' ||
      body.systemPrompt.trim() === ''
    ) {
      return { patch, error: 'systemPrompt is required' };
    }
    patch.systemPrompt = body.systemPrompt;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') {
      return { patch, error: 'model must be a string' };
    }
    patch.model = body.model;
  }
  if (body.tools !== undefined) {
    const tools = parseStringArray(body.tools);
    if (!tools) {
      return { patch, error: 'tools must be an array of strings' };
    }
    patch.tools = tools;
  }
  return { patch };
}

function invalidSubagent(error: string): SubagentValidation {
  return {
    config: { name: '', description: '', systemPrompt: '' },
    error,
  };
}

function parseStringArray(value: SubagentField): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    values.push(item);
  }
  return values;
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

async function handleDesktopUpgrade(
  req: IncomingMessage,
  socket: import('node:net').Socket,
  _head: Buffer,
  registry: Registry,
): Promise<void> {
  const reqUrl = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const match = /^\/api\/agents\/([^/]+)\/desktop\/proxy\/?(.*)$/.exec(
    reqUrl.pathname,
  );
  if (!match) {
    socket.destroy();
    return;
  }
  const id = decodeURIComponent(match[1]!);
  const subPath = match[2] ?? '';
  const diskRegistry = await loadRegistry();
  const entry =
    diskRegistry.agents.find((agent) => agent.id === id) ??
    registry.agents.find((agent) => agent.id === id);
  if (!entry || entry.vncPort === undefined || !entry.vncPassword) {
    socket.destroy();
    return;
  }
  const authHeader = `Basic ${Buffer.from(`kasm_user:${entry.vncPassword}`).toString('base64')}`;

  const targetSocket = tlsConnect({
    port: entry.vncPort,
    host: '127.0.0.1',
    rejectUnauthorized: false,
  });
  let targetReady = false;

  targetSocket.on('connect', () => {
    targetReady = true;
    let rawReq = `${req.method ?? 'GET'} /${subPath}${reqUrl.search} HTTP/1.1\r\n`;
    for (const [key, val] of Object.entries(req.headers)) {
      if (
        key.toLowerCase() === 'host' ||
        key.toLowerCase() === 'authorization' ||
        key.toLowerCase() === 'origin'
      )
        continue;
      if (typeof val === 'string') rawReq += `${key}: ${val}\r\n`;
    }
    rawReq += `host: localhost:${entry.vncPort}\r\n`;
    rawReq += `authorization: ${authHeader}\r\n`;
    rawReq += `sec-websocket-origin: ${reqUrl.origin}\r\n`;
    if (!rawReq.toLowerCase().includes('sec-websocket-protocol:')) {
      rawReq += 'sec-websocket-protocol: binary\r\n';
    }
    rawReq += '\r\n';
    targetSocket.write(rawReq);
  });

  targetSocket.on('data', (data) => socket.write(data));
  socket.on('data', (data) => {
    if (targetReady) targetSocket.write(data);
  });
  targetSocket.on('error', () => socket.destroy());
  socket.on('error', () => targetSocket.destroy());
  targetSocket.on('close', () => socket.destroy());
  socket.on('close', () => targetSocket.destroy());
}
