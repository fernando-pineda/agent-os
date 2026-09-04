import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GlobalConfig } from '@agent-os/core';

const configPath = join(homedir(), '.agent-os', 'config.json');

export function resetModelCache(): void {
  modelCache = undefined;
}

interface ModelEntry {
  id: string;
  supportsTools: boolean;
  supportsVision?: boolean;
  provider: string;
  name?: string;
  contextWindow?: number;
}

interface ModelCache {
  fetchedAt: number;
  models: ModelEntry[];
}

let modelCache: ModelCache | undefined;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isConfigured(): Promise<boolean> {
  // Pi owns provider credentials. agent-os is always "configured" as long
  // as Pi can resolve a model (env vars, ~/.pi/agent/auth.json, or OAuth).
  return true;
}

export async function readGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return null;
  }
}

export async function ensureConfig(): Promise<GlobalConfig> {
  const existing = await readGlobalConfig();
  if (existing) return existing;
  // Create a minimal config so the supervisor does not 404 on /api/config.
  const config: GlobalConfig = {
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
  return config;
}

export async function updateGlobalConfig(patch: {
  defaultModel?: string;
  reminders?: string[];
}): Promise<GlobalConfig> {
  const current = (await readGlobalConfig()) ?? (await ensureConfig());
  if (patch.defaultModel !== undefined) {
    current.defaultModel = patch.defaultModel;
  }
  if (patch.reminders !== undefined) {
    current.reminders = patch.reminders;
  }
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(current, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
  resetModelCache();
  return current;
}

export async function listModels(): Promise<{
  models: ModelEntry[];
  warning?: string;
}> {
  const now = Date.now();
  if (modelCache && now - modelCache.fetchedAt < CACHE_TTL_MS) {
    return { models: modelCache.models };
  }

  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const modelRuntime = await ModelRuntime.create();
    // Only list models from providers with valid credentials.
    const available = await modelRuntime.getAvailable();
    const entries: ModelEntry[] = available.map((model) => ({
      id: `${model.provider}/${model.id}`,
      supportsTools: true,
      ...(model.input?.includes('image') ? { supportsVision: true } : {}),
      provider: model.provider,
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    }));

    modelCache = { fetchedAt: now, models: entries };
    return { models: entries };
  } catch (err) {
    const warning = (err as Error).message ?? String(err);
    return {
      models: [],
      warning: `Could not load models from Pi: ${warning}`,
    };
  }
}
