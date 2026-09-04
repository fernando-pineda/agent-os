import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GlobalConfig } from '@agent-os/core';
import { readGlobalConfig } from './onboarding.js';

const configPath = join(homedir(), '.agent-os', 'config.json');
const subagentNamePattern = /^[a-z0-9-]{1,64}$/;

export interface SubagentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

type GlobalConfigWithSubagents = GlobalConfig & {
  subagents?: SubagentConfig[];
};

export async function listSubagents(): Promise<SubagentConfig[]> {
  const config = await readGlobalConfig();
  if (!config) return [];
  const configured: GlobalConfigWithSubagents = config;
  return configured.subagents ?? [];
}

export async function createSubagent(
  config: SubagentConfig,
): Promise<SubagentConfig> {
  validateSubagent(config);
  const current = await readGlobalConfig();
  if (!current) {
    throw new Error('Not configured');
  }
  const configured: GlobalConfigWithSubagents = current;
  const subagents = configured.subagents ?? [];
  if (subagents.some((subagent) => subagent.name === config.name)) {
    throw new Error('duplicate');
  }
  subagents.push(config);
  await persistConfig(configured, subagents);
  return config;
}

export async function updateSubagent(
  name: string,
  patch: Partial<SubagentConfig>,
): Promise<SubagentConfig | null> {
  const config = await readGlobalConfig();
  if (!config) {
    throw new Error('Not configured');
  }
  const configured: GlobalConfigWithSubagents = config;
  const subagents = configured.subagents ?? [];
  const index = subagents.findIndex((subagent) => subagent.name === name);
  if (index === -1) return null;

  const existing = subagents[index]!;
  const updated: SubagentConfig = { ...existing, ...patch };
  validateSubagent(updated);
  if (
    updated.name !== name &&
    subagents.some((subagent) => subagent.name === updated.name)
  ) {
    throw new Error('duplicate');
  }
  subagents[index] = updated;
  await persistConfig(configured, subagents);
  return updated;
}

export async function deleteSubagent(name: string): Promise<boolean> {
  const config = await readGlobalConfig();
  if (!config) {
    throw new Error('Not configured');
  }
  const configured: GlobalConfigWithSubagents = config;
  const subagents = configured.subagents ?? [];
  const index = subagents.findIndex((subagent) => subagent.name === name);
  if (index === -1) return false;
  subagents.splice(index, 1);
  await persistConfig(configured, subagents);
  return true;
}

function validateSubagent(config: SubagentConfig): void {
  if (
    typeof config.name !== 'string' ||
    !subagentNamePattern.test(config.name)
  ) {
    throw new Error(
      'name must be 1-64 characters using lowercase letters, numbers, and hyphens',
    );
  }
  if (
    typeof config.description !== 'string' ||
    config.description.trim() === ''
  ) {
    throw new Error('description is required');
  }
  if (
    typeof config.systemPrompt !== 'string' ||
    config.systemPrompt.trim() === ''
  ) {
    throw new Error('systemPrompt is required');
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    throw new Error('model must be a string');
  }
  if (
    config.tools !== undefined &&
    (!Array.isArray(config.tools) ||
      !config.tools.every((tool): tool is string => typeof tool === 'string'))
  ) {
    throw new Error('tools must be an array of strings');
  }
}

async function persistConfig(
  config: GlobalConfigWithSubagents,
  subagents: SubagentConfig[],
): Promise<void> {
  config.subagents = subagents;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
}
