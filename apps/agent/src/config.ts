import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, GlobalConfig } from '@agent-os/core';

export interface LoadedAgentConfig {
  config: GlobalConfig;
  agent: AgentConfig;
  model: string;
  workspace: string;
  homeDir: string;
}

export async function loadAgentConfig(
  agentId: string,
): Promise<LoadedAgentConfig> {
  const registryPath = join(
    homedir(),
    '.agent-os',
    'agents',
    agentId,
    'config.json',
  );
  const globalPath = join(homedir(), '.agent-os', 'config.json');

  let globalRaw: string;
  try {
    globalRaw = await readFile(globalPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Missing global config at ${globalPath}. Onboard first: ${(err as Error).message}`,
    );
  }

  let agentRaw: string;
  try {
    agentRaw = await readFile(registryPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Missing agent registry config for ${agentId} at ${registryPath}: ${(err as Error).message}`,
    );
  }

  const config = JSON.parse(globalRaw) as GlobalConfig;
  const agent = JSON.parse(agentRaw) as AgentConfig;

  if (agent.id !== agentId) {
    throw new Error(`Agent config id mismatch: ${agent.id} vs ${agentId}`);
  }

  const workspace = agent.workspace ?? agent.id;
  const homeDir = process.env.AGENT_OS_HOME ?? `/Users/agentos-${workspace}`;
  const model = agent.model ?? config.defaultModel;
  return { config, agent, model, workspace, homeDir };
}
