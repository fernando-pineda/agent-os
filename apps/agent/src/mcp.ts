import type {
  McpServerConfig,
  Tool,
  ToolContext,
  ToolResult,
} from '@agent-os/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface McpConnection {
  name: string;
  tools: Tool[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10_000;

function buildStdioParams(server: McpServerConfig): StdioServerParameters {
  const params: StdioServerParameters = {
    command: server.command ?? '',
    stderr: 'inherit',
  };
  if (server.args) params.args = server.args;
  if (server.env) params.env = server.env;
  return params;
}

function buildHttpOpts(
  server: McpServerConfig,
): StreamableHTTPClientTransportOptions {
  const opts: StreamableHTTPClientTransportOptions = {};
  if (server.headers) {
    opts.requestInit = { headers: server.headers };
  }
  return opts;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`MCP server "${label}" connect timed out after ${ms}ms`),
      );
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      (block as Record<string, unknown>).type === 'text'
    ) {
      parts.push(String((block as Record<string, unknown>).text));
    }
  }
  return parts.join('\n');
}

function wrapTool(
  serverName: string,
  client: Client,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Tool {
  const spec = {
    name: `${serverName}__${name}`,
    description,
    parameters: inputSchema,
  };
  return {
    spec,
    async execute(
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      try {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) {
          return {
            ok: false,
            output:
              contentToText(result.content) ||
              `MCP tool ${name} returned an error`,
            isError: true,
          };
        }
        return { ok: true, output: contentToText(result.content) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `MCP tool ${name} failed: ${msg}` };
      }
    },
  };
}

async function connectOne(server: McpServerConfig): Promise<McpConnection> {
  // Cast through unknown: the MCP SDK's Transport optional properties
  // are incompatible with exactOptionalPropertyTypes.
  let transport: Transport;
  if (server.transport === 'http') {
    transport = new StreamableHTTPClientTransport(
      new URL(server.url ?? ''),
      buildHttpOpts(server),
    ) as unknown as Transport;
  } else {
    transport = new StdioClientTransport(
      buildStdioParams(server),
    ) as unknown as Transport;
  }

  const client = new Client(
    { name: 'agent-os', version: '0.0.0' },
    { capabilities: {} },
  );

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, server.name);
  const { tools } = await withTimeout(
    client.listTools(),
    CONNECT_TIMEOUT_MS,
    server.name,
  );

  const wrapped: Tool[] = tools.map((t) =>
    wrapTool(
      server.name,
      client,
      t.name,
      t.description ?? '',
      t.inputSchema as Record<string, unknown>,
    ),
  );

  return {
    name: server.name,
    tools: wrapped,
    async close() {
      await client.close();
    },
  };
}

export async function connectMcpServers(
  servers: McpServerConfig[],
  activeNames: string[],
): Promise<McpConnection[]> {
  const configs = activeNames
    .map((name) => servers.find((s) => s.name === name))
    .filter((s): s is McpServerConfig => s !== undefined);

  for (const name of activeNames) {
    if (!configs.some((s) => s.name === name)) {
      console.warn(`MCP server "${name}" not found in config, skipping`);
    }
  }

  const results = await Promise.allSettled(configs.map((s) => connectOne(s)));

  const connections: McpConnection[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === 'fulfilled') {
      connections.push(result.value);
    } else if (result && result.status === 'rejected') {
      const config = configs[i];
      if (config) {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        console.warn(`MCP server "${config.name}" failed to connect: ${msg}`);
      }
    }
  }

  return connections;
}

export async function closeMcpConnections(
  connections: McpConnection[],
): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()));
}
