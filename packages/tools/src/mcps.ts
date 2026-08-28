import type { Tool, ToolResult } from '@agent-os/core';

const SUPERVISOR_BASE = 'http://localhost:8787';

function supervisorError(status: number, body: string): ToolResult {
  return { ok: false, output: `supervisor ${status}: ${body.slice(0, 300)}` };
}

function errorResult(err: unknown): ToolResult {
  return {
    ok: false,
    output: err instanceof Error ? err.message : String(err),
  };
}

interface McpServerEntry {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function isMcpServer(value: unknown): value is McpServerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as { name?: unknown; transport?: unknown };
  return (
    typeof c.name === 'string' &&
    (c.transport === 'stdio' || c.transport === 'http')
  );
}

// Never leak secret values to the model; expose only key names.
function redact(server: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: server.name,
    transport: server.transport,
  };
  if (server.command !== undefined) out.command = server.command;
  if (server.args !== undefined) out.args = server.args;
  if (server.url !== undefined) out.url = server.url;
  if (server.env !== undefined) out.envKeys = Object.keys(server.env);
  if (server.headers !== undefined)
    out.headerKeys = Object.keys(server.headers);
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

// Validates and builds the request body shared by create and update.
function buildServerPayload(
  args: Record<string, unknown>,
): { payload: Record<string, unknown> } | { error: ToolResult } {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { error: { ok: false, output: 'name is required' } };
  }
  const transport = args.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    return {
      error: { ok: false, output: "transport must be 'stdio' or 'http'" },
    };
  }
  const payload: Record<string, unknown> = { name, transport };
  if (transport === 'stdio') {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
      return {
        error: {
          ok: false,
          output: 'command is required for stdio transport',
        },
      };
    }
    payload.command = command;
    if (isStringArray(args.args)) payload.args = args.args;
    if (isStringRecord(args.env)) payload.env = args.env;
  } else {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      return {
        error: { ok: false, output: 'url is required for http transport' },
      };
    }
    payload.url = url;
    if (isStringRecord(args.headers)) payload.headers = args.headers;
  }
  return { payload };
}

async function parseJsonBody(res: Response): Promise<unknown | undefined> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export const mcpList: Tool = {
  spec: {
    name: 'mcp_list',
    description:
      'List the configured MCP plugin servers (name, transport, url/command). Secret env/header values are never returned, only key names.',
    parameters: { type: 'object', properties: {} },
  },

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/mcp`);
      const body = await res.text();
      if (!res.ok) return supervisorError(res.status, body);
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return {
          ok: false,
          output: `invalid JSON from supervisor: ${body.slice(0, 300)}`,
        };
      }
      const servers =
        typeof data === 'object' && data !== null && 'servers' in data
          ? (data as { servers: unknown[] }).servers.filter(isMcpServer)
          : [];
      return {
        ok: true,
        output: JSON.stringify(servers.map(redact), null, 2),
      };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const mcpCreate: Tool = {
  spec: {
    name: 'mcp_create',
    description:
      'Register a new MCP plugin server. stdio needs command (plus optional args, env); http needs url (plus optional headers).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'http'] },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object' },
        url: { type: 'string' },
        headers: { type: 'object' },
      },
      required: ['name', 'transport'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const built = buildServerPayload(args);
    if ('error' in built) return built.error;
    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const data = await parseJsonBody(res);
      if (!res.ok) {
        return supervisorError(res.status, JSON.stringify(data ?? {}));
      }
      if (!isMcpServer(data)) {
        return { ok: false, output: 'unexpected response from supervisor' };
      }
      return {
        ok: true,
        output: `Created MCP server "${data.name}".\n${JSON.stringify(redact(data), null, 2)}`,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const mcpUpdate: Tool = {
  spec: {
    name: 'mcp_update',
    description:
      'Update an MCP plugin server. name is the current name; pass newName to rename. Omitted fields keep their existing values.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        newName: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'http'] },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object' },
        url: { type: 'string' },
        headers: { type: 'object' },
      },
      required: ['name'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, output: 'name is required' };
    const body: Record<string, unknown> = {};
    if (typeof args.newName === 'string' && args.newName.trim())
      body.name = args.newName.trim();
    if (args.transport === 'stdio' || args.transport === 'http')
      body.transport = args.transport;
    if (typeof args.command === 'string') body.command = args.command;
    if (isStringArray(args.args)) body.args = args.args;
    if (isStringRecord(args.env)) body.env = args.env;
    if (typeof args.url === 'string') body.url = args.url;
    if (isStringRecord(args.headers)) body.headers = args.headers;
    try {
      const res = await fetch(
        `${SUPERVISOR_BASE}/api/mcp/${encodeURIComponent(name)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await parseJsonBody(res);
      if (!res.ok) {
        return supervisorError(res.status, JSON.stringify(data ?? {}));
      }
      return { ok: true, output: `Updated MCP server "${name}".` };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const mcpDelete: Tool = {
  spec: {
    name: 'mcp_delete',
    description:
      'Remove an MCP plugin server. This only deletes the configuration entry, nothing else.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, output: 'name is required' };
    try {
      const res = await fetch(
        `${SUPERVISOR_BASE}/api/mcp/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      const body = await res.text();
      if (!res.ok) return supervisorError(res.status, body);
      return { ok: true, output: `Deleted MCP server "${name}".` };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const mcpStatus: Tool = {
  spec: {
    name: 'mcp_status',
    description:
      'Check reachability of each configured MCP plugin server. Returns a map of server name to online | offline | unknown.',
    parameters: { type: 'object', properties: {} },
  },

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/mcp/status`);
      const body = await res.text();
      if (!res.ok) return supervisorError(res.status, body);
      return { ok: true, output: body };
    } catch (err) {
      return errorResult(err);
    }
  },
};
