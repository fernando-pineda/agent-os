import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import type {
  AgentConfig,
  AgentStatus,
  LLMClient,
  Tool,
  ToolContext,
} from '@agent-os/core';
import {
  FireworksLLMClient,
  MockLLMClient,
  ZaiLLMClient,
} from '@agent-os/core';
import { wrapWithSandbox } from '@agent-os/sandbox';
import { defaultTools, TmuxSession } from '@agent-os/tools';
import { createAutomationScheduler } from './automations.js';
import { scheduleCompaction } from './compact.js';
import { loadAgentConfig } from './config.js';
import {
  closeMcpConnections,
  connectMcpServers,
  type McpConnection,
} from './mcp.js';
import { drainOutbox } from './outbox.js';
import { createAgentServer, sendAgentMessageHttp } from './server.js';

const rawAgentId = process.argv[2] ?? process.env.AGENT_ID;
if (!rawAgentId || typeof rawAgentId !== 'string') {
  console.error('Usage: agent-os-agent <agent-id> or set AGENT_ID');
  process.exit(1);
}
const agentId = rawAgentId;

let loadedConfig: Awaited<ReturnType<typeof loadAgentConfig>> | undefined;
let _currentStatus: AgentStatus = 'starting';
let mcpConnections: McpConnection[] = [];
let serverRef: ReturnType<typeof createAgentServer>;

async function main(): Promise<void> {
  loadedConfig = await loadAgentConfig(agentId);
  const { config, agent, model, workspace, homeDir } = loadedConfig;
  const apiKey = process.env.FIREWORKS_API_KEY ?? config.apiKey;
  const myPort = process.env.AGENT_PORT;
  const resolvedPort = myPort ? Number(myPort) : undefined;

  if (!resolvedPort || Number.isNaN(resolvedPort)) {
    console.error('AGENT_PORT must be set');
    process.exit(1);
  }
  process.env.AGENT_PORT = String(resolvedPort);

  await mkdir(homeDir, { recursive: true });
  await provisionGit(agent.git, homeDir);

  const llm: LLMClient =
    process.env.AGENT_OS_MOCK_LLM === '1'
      ? new MockLLMClient()
      : config.provider === 'zai'
        ? new ZaiLLMClient(apiKey)
        : new FireworksLLMClient(apiKey);

  console.log(
    `Agent ${agentId} workspace ${workspace} home ${homeDir} model ${model} port ${resolvedPort}`,
  );

  try {
    await TmuxSession.create(`agent-os-${agentId}`, homeDir);
  } catch (err) {
    console.warn(
      `Tmux session not created: ${err instanceof Error ? err.message : String(err)}. Continuing in-process.`,
    );
  }

  const tools = buildTools(agent.sandboxed ?? false, homeDir, workspace);

  const activeMcp = (config.mcpServers ?? []).filter((s) =>
    agent.plugins?.includes(s.name),
  );
  const mcpConns = await connectMcpServers(activeMcp, agent.plugins ?? []);
  mcpConnections = mcpConns;
  const mcpTools = mcpConns.flatMap((c) => c.tools);
  const allTools = [...tools, ...mcpTools];

  const scheduler = createAutomationScheduler({
    homeDir,
    agentId,
    mcpConnections: mcpConns,
    isBusy: () => serverRef.isBusy(),
    buildContext: (signal) =>
      buildContext(agentId, workspace, homeDir, signal, agent),
  });

  const server = createAgentServer({
    agentId,
    workspace,
    homeDir,
    agent,
    model,
    provider: config.provider,
    llm,
    tools: allTools,
    status: 'starting',
    onStatusChange: (status) => {
      _currentStatus = status;
    },
    buildContext: (signal) =>
      buildContext(agentId, workspace, homeDir, signal, agent),
    sendAgentMessage: (to, msg, opts) =>
      sendAgentMessageHttp(to, msg, homeDir, opts?.replyDepth ?? 0),
    onPluginsReload: async () => {
      const fresh = await loadAgentConfig(agentId);
      const plugins = fresh.agent.plugins ?? [];
      const active = (config.mcpServers ?? []).filter((s) =>
        plugins.includes(s.name),
      );
      await closeMcpConnections(mcpConnections);
      const conns = await connectMcpServers(active, plugins);
      mcpConnections = conns;
      scheduler.setMcpConnections(conns);
      return [...tools, ...conns.flatMap((c) => c.tools)];
    },
  });
  serverRef = server;

  server.setStatus('online');
  _currentStatus = 'online';

  await scheduler.start();
  server.setScheduler(scheduler);

  const stopCompaction = scheduleCompaction({
    homeDir,
    llm,
    model,
    setStatus: (s) => server.setStatus(s),
    isBusy: () => server.isBusy(),
  });

  const port = await server.start();
  console.log(`Agent HTTP server listening on http://localhost:${port}`);

  void drainOutbox(homeDir, agentId).catch((err) => {
    console.error('Failed to drain outbox on startup', err);
  });
  const outboxTimer = setInterval(() => {
    void drainOutbox(homeDir, agentId).catch(() => undefined);
  }, 15000);

  process.on('SIGTERM', () => {
    stopCompaction();
    clearInterval(outboxTimer);
    void shutdown(server, scheduler);
  });
  process.on('SIGINT', () => {
    stopCompaction();
    clearInterval(outboxTimer);
    void shutdown(server, scheduler);
  });

  process.on('uncaughtException', (err: Error) => {
    console.error('Uncaught exception', err);
    _currentStatus = 'error';
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection', reason);
    _currentStatus = 'error';
  });

  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

async function shutdown(
  server: Awaited<ReturnType<typeof createAgentServer>>,
  scheduler: Awaited<ReturnType<typeof createAutomationScheduler>>,
): Promise<void> {
  _currentStatus = 'stopped';
  console.log('Shutting down agent...');
  scheduler.stop();
  await closeMcpConnections(mcpConnections);
  await server.stop();
  process.exit(0);
}

function buildContext(
  agentId: string,
  workspace: string,
  homeDir: string,
  signal: AbortSignal | undefined,
  agent: AgentConfig,
): ToolContext {
  return {
    agentId,
    workspace,
    homeDir,
    signal,
    group: agent.group,
    env: buildEnv(agent),
    sendAgentMessage: (to, msg, opts) =>
      sendAgentMessageHttp(to, msg, homeDir, opts?.replyDepth ?? 0),
  };
}

function buildEnv(agent: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (agent.git?.userName) env.GIT_AUTHOR_NAME = agent.git.userName;
  if (agent.git?.userEmail) env.GIT_AUTHOR_EMAIL = agent.git.userEmail;
  return env;
}

// agent.plugins holds MCP server names; built-ins are always included.
// MCP servers matching plugin names are connected at startup and their
// tools are merged in as <server>__<tool>.
function buildTools(
  sandboxed: boolean,
  homeDir: string,
  workspace: string,
): Tool[] {
  const base = defaultTools();
  if (!sandboxed) {
    return base;
  }
  return base.map((tool) => {
    if (tool.spec.name === 'shell') {
      return wrapWithSandbox(tool, 'agentShell', { workspace, homeDir });
    }
    return tool;
  });
}

async function provisionGit(
  git: Awaited<ReturnType<typeof loadAgentConfig>>['agent']['git'],
  homeDir: string,
): Promise<void> {
  if (!git) return;
  await mkdir(homeDir, { recursive: true });
  if (git.userName && git.userEmail) {
    const gitconfig = `[user]\n\tname = ${git.userName}\n\temail = ${git.userEmail}\n`;
    await writeFile(join(homeDir, '.gitconfig'), gitconfig, 'utf-8');
  }
  if (git.credential) {
    await writeFile(join(homeDir, '.git-credentials'), git.credential, {
      mode: 0o600,
      encoding: 'utf-8',
    });
  }
  if (git.sshKeyPath) {
    await mkdir(join(homeDir, '.ssh'), { recursive: true });
    await writeFile(
      join(homeDir, '.ssh', 'config'),
      `IdentityFile ${git.sshKeyPath}\n`,
      'utf-8',
    ).catch(() => undefined);
  }
}

void main();
