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
import { FireworksLLMClient, MockLLMClient } from '@agent-os/core';
import { wrapWithSandbox } from '@agent-os/sandbox';
import { defaultTools, TmuxSession } from '@agent-os/tools';
import { scheduleCompaction } from './compact.js';
import { loadAgentConfig } from './config.js';
import { createAgentServer, sendAgentMessageHttp } from './server.js';

const rawAgentId = process.argv[2] ?? process.env.AGENT_ID;
if (!rawAgentId || typeof rawAgentId !== 'string') {
  console.error('Usage: agent-os-agent <agent-id> or set AGENT_ID');
  process.exit(1);
}
const agentId = rawAgentId;

let loadedConfig: Awaited<ReturnType<typeof loadAgentConfig>> | undefined;
let _currentStatus: AgentStatus = 'starting';

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

  const tools = buildTools(agent.sandboxed ?? false, homeDir, workspace, agent);
  const server = createAgentServer({
    agentId,
    workspace,
    homeDir,
    agent,
    model,
    llm,
    tools,
    status: 'starting',
    onStatusChange: (status) => {
      _currentStatus = status;
    },
    buildContext: (signal) =>
      buildContext(agentId, workspace, homeDir, signal, agent),
    sendAgentMessage: sendAgentMessageHttp,
  });

  server.setStatus('online');
  _currentStatus = 'online';

  const stopCompaction = scheduleCompaction({
    homeDir,
    llm,
    model,
    setStatus: (s) => server.setStatus(s),
    isBusy: () => server.isBusy(),
  });

  const port = await server.start();
  console.log(`Agent HTTP server listening on http://localhost:${port}`);

  process.on('SIGTERM', () => {
    stopCompaction();
    void shutdown(server);
  });
  process.on('SIGINT', () => {
    stopCompaction();
    void shutdown(server);
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
): Promise<void> {
  _currentStatus = 'stopped';
  console.log('Shutting down agent...');
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
    env: buildEnv(agent),
    sendAgentMessage: sendAgentMessageHttp,
  };
}

function buildEnv(agent: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (agent.git?.userName) env.GIT_AUTHOR_NAME = agent.git.userName;
  if (agent.git?.userEmail) env.GIT_AUTHOR_EMAIL = agent.git.userEmail;
  return env;
}

function buildTools(
  sandboxed: boolean,
  homeDir: string,
  workspace: string,
  agent: AgentConfig,
): Tool[] {
  const base = defaultTools();
  const enabled = agent.plugins;
  const filtered = enabled
    ? base.filter((t) => enabled.includes(t.spec.name))
    : base;
  if (!sandboxed) {
    return filtered;
  }
  return filtered.map((tool) => {
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
    await writeFile(
      join(homeDir, '.ssh', 'config'),
      `IdentityFile ${git.sshKeyPath}\n`,
      'utf-8',
    ).catch(() => undefined);
  }
}

void main();
