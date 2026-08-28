import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import type { AgentInfo } from '@agent-os/core';
import { installLaunchdAgent, uninstallLaunchdAgent } from './launchd.js';
import {
  isConfigured,
  listModels,
  onboard,
  readGlobalConfig,
} from './onboarding.js';
import type { CreateAgentInput, Registry } from './registry.js';
import {
  createAgent,
  getAgentPort,
  startAgent,
  stopAgent,
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  if (pathname === '/api/models' && req.method === 'GET') {
    const result = await listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/agents' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: statusTracker.getAgents() }));
    return;
  }

  if (pathname === '/api/agents' && req.method === 'POST') {
    const body = await readJson(req);
    const config = await readGlobalConfig();
    const result = await createAgent(
      registry,
      body as CreateAgentInput,
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

async function shutdown(
  server: ReturnType<typeof createServer>,
  statusTracker: StatusTracker,
): Promise<void> {
  await statusTracker.close();
  server.close(() => {
    process.exit(0);
  });
}
