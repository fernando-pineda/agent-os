import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  GlobalConfig,
  McpServerConfig,
  McpStatus,
  McpStatusResponse,
} from '@agent-os/core';
import { readGlobalConfig } from './onboarding.js';

const configPath = join(homedir(), '.agent-os', 'config.json');

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const config = await readGlobalConfig();
  return config?.mcpServers ?? [];
}

export async function createMcpServer(
  server: McpServerConfig,
): Promise<McpServerConfig> {
  const config = await readGlobalConfig();
  if (!config) {
    throw new Error('Not configured');
  }
  const servers = config.mcpServers ?? [];
  if (servers.some((s) => s.name === server.name)) {
    throw new Error('duplicate');
  }
  servers.push(server);
  await persistConfig(config, servers);
  return server;
}

export async function updateMcpServer(
  name: string,
  patch: Partial<McpServerConfig>,
): Promise<McpServerConfig | null> {
  const config = await readGlobalConfig();
  if (!config) {
    throw new Error('Not configured');
  }
  const servers = config.mcpServers ?? [];
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) return null;
  const existing = servers[idx]!;
  if (patch.name && patch.name !== name) {
    if (servers.some((s) => s.name === patch.name)) {
      throw new Error('duplicate');
    }
  }
  const updated: McpServerConfig = {
    name: patch.name ?? existing.name,
    transport: patch.transport ?? existing.transport,
  };
  if (updated.transport === 'stdio') {
    if (patch.command !== undefined) {
      updated.command = patch.command;
    } else if (existing.command !== undefined) {
      updated.command = existing.command;
    }
    if (patch.args !== undefined) {
      updated.args = patch.args;
    } else if (existing.args !== undefined) {
      updated.args = existing.args;
    }
    if (patch.env !== undefined) {
      updated.env = patch.env;
    } else if (existing.env !== undefined) {
      updated.env = existing.env;
    }
  } else {
    if (patch.url !== undefined) {
      updated.url = patch.url;
    } else if (existing.url !== undefined) {
      updated.url = existing.url;
    }
    if (patch.headers !== undefined) {
      updated.headers = patch.headers;
    } else if (existing.headers !== undefined) {
      updated.headers = existing.headers;
    }
  }
  servers[idx] = updated;
  await persistConfig(config, servers);
  return updated;
}

export async function deleteMcpServer(name: string): Promise<boolean> {
  const config = await readGlobalConfig();
  if (!config) {
    throw new Error('Not configured');
  }
  const servers = config.mcpServers ?? [];
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) return false;
  servers.splice(idx, 1);
  await persistConfig(config, servers);
  return true;
}

async function persistConfig(
  config: GlobalConfig,
  servers: McpServerConfig[],
): Promise<void> {
  config.mcpServers = servers;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
}

export async function probeMcpStatuses(): Promise<McpStatusResponse> {
  const servers = await listMcpServers();
  const entries = await Promise.all(
    servers.map(
      async (server): Promise<[string, McpStatus]> => [
        server.name,
        await probeServer(server),
      ],
    ),
  );
  const statuses: Record<string, McpStatus> = {};
  for (const [name, status] of entries) {
    statuses[name] = status;
  }
  return { statuses };
}

async function probeServer(server: McpServerConfig): Promise<McpStatus> {
  if (server.transport === 'http') {
    return probeHttp(server);
  }
  // stdio probing not implemented; would require spawning the process
  return 'unknown';
}

async function probeHttp(server: McpServerConfig): Promise<McpStatus> {
  const url = server.url;
  if (!url) return 'unknown';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agent-os', version: '0.0.0' },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return response.status < 500 ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}
