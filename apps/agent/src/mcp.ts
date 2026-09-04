import type {
  McpServerConfig,
  Tool,
  ToolContext,
  ToolResult,
} from '@agent-os/core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Local type definitions for pi-mcp-adapter. The package exports .ts files
// at its root entry which tsc cannot compile without allowImportingTsExtensions.
// We type the API surface locally and use a dynamic import at runtime (tsx
// loader handles .ts). Types verified against pi-mcp-adapter@2.32.1.

interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  lifecycle?: 'lazy' | 'eager' | 'keep-alive' | 'lazy-keep-alive';
}

interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
}

export interface McpConnection {
  name: string;
  tools: Tool[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10_000;

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type CreateMcpAdapterFn = (options?: {
  config?: McpConfig;
  configPath?: string;
}) => ExtensionFactory;

let createMcpAdapter: CreateMcpAdapterFn | undefined;

// Variable path prevents tsc from statically resolving the .ts root entry.
// tsx handles .ts at runtime. Types are defined locally above.
const MCP_ADAPTER_MODULE = 'pi-mcp-adapter';

async function getCreateMcpAdapter(): Promise<CreateMcpAdapterFn> {
  const loaded = createMcpAdapter;
  if (loaded) return loaded;

  const module = (await import(MCP_ADAPTER_MODULE)) as {
    createMcpAdapter: CreateMcpAdapterFn;
  };
  createMcpAdapter = module.createMcpAdapter;
  return module.createMcpAdapter;
}

function selectServers(
  servers: McpServerConfig[],
  activeNames: string[],
): McpServerConfig[] {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const selected: McpServerConfig[] = [];

  for (const name of activeNames) {
    const server = byName.get(name);
    if (server) {
      selected.push(server);
    } else {
      console.warn(`MCP server "${name}" not found in config, skipping`);
    }
  }

  return selected;
}

function buildServerEntry(server: McpServerConfig): ServerEntry {
  const lifecycle: Pick<ServerEntry, 'lifecycle'> = { lifecycle: 'lazy' };

  if (server.transport === 'http') {
    return {
      ...lifecycle,
      ...(server.url !== undefined ? { url: server.url } : {}),
      ...(server.headers !== undefined ? { headers: server.headers } : {}),
    };
  }

  return {
    ...lifecycle,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
  };
}

function buildMcpConfig(
  servers: McpServerConfig[],
  activeNames: string[],
): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};

  for (const server of selectServers(servers, activeNames)) {
    mcpServers[server.name] = buildServerEntry(server);
  }

  return { mcpServers };
}

type ToolArguments = Parameters<Tool['execute']>[0];
type ToolParameters = Tool['spec']['parameters'];

export function rebuildMcpForSession(
  mcpServers: McpServerConfig[],
  plugins: string[],
): ExtensionFactory {
  const config = buildMcpConfig(mcpServers, plugins);

  return async (pi) => {
    const adapter = await getCreateMcpAdapter();
    await adapter({ config })(pi);
  };
}

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
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function contentToText(content: CallToolResult['content']): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

type ClientCallToolResult = Awaited<ReturnType<Client['callTool']>>;

function isCallToolResult(
  result: ClientCallToolResult,
): result is CallToolResult {
  return 'content' in result;
}

function wrapTool(
  serverName: string,
  client: Client,
  name: string,
  description: string,
  inputSchema: ToolParameters,
): Tool {
  const spec = {
    name: `${serverName}__${name}`,
    description,
    parameters: inputSchema,
  };
  return {
    spec,
    async execute(args: ToolArguments, _ctx: ToolContext): Promise<ToolResult> {
      try {
        const result = await client.callTool({ name, arguments: args });
        if (!isCallToolResult(result)) {
          return {
            ok: false,
            output: `MCP tool ${name} returned an unsupported task result`,
            isError: true,
          };
        }
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `MCP tool ${name} failed: ${message}` };
      }
    },
  };
}

async function connectOne(server: McpServerConfig): Promise<McpConnection> {
  let transport: Transport;
  if (server.transport === 'http') {
    transport = new StreamableHTTPClientTransport(
      new URL(server.url ?? ''),
      buildHttpOpts(server),
    ) as Transport;
  } else {
    transport = new StdioClientTransport(buildStdioParams(server)) as Transport;
  }

  const client = new Client(
    { name: 'agent-os', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      server.name,
    );
    const { tools } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      server.name,
    );

    const wrapped: Tool[] = tools.map((tool) =>
      wrapTool(
        server.name,
        client,
        tool.name,
        tool.description ?? '',
        tool.inputSchema,
      ),
    );

    return {
      name: server.name,
      tools: wrapped,
      async close() {
        await client.close();
      },
    };
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      const message =
        closeError instanceof Error ? closeError.message : String(closeError);
      console.warn(`MCP server "${server.name}" cleanup failed: ${message}`);
    }
    throw error;
  }
}

export async function rebuildAutomationMcp(
  mcpServers: McpServerConfig[],
  plugins: string[],
): Promise<McpConnection[]> {
  const configs = selectServers(mcpServers, plugins);
  const results = await Promise.allSettled(
    configs.map((server) => connectOne(server)),
  );
  const connections: McpConnection[] = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result?.status === 'fulfilled') {
      connections.push(result.value);
      continue;
    }

    const config = configs[index];
    if (config && result?.status === 'rejected') {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.warn(`MCP server "${config.name}" failed to connect: ${message}`);
    }
  }

  return connections;
}

export async function closeAutomationMcp(
  connections: McpConnection[],
): Promise<void> {
  const results = await Promise.allSettled(
    connections.map((connection) => connection.close()),
  );

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result?.status === 'rejected') {
      const connection = connections[index];
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.warn(
        `MCP server "${connection?.name ?? 'unknown'}" cleanup failed: ${message}`,
      );
    }
  }
}

export const connectMcpServers = rebuildAutomationMcp;
export const closeMcpConnections = closeAutomationMcp;
