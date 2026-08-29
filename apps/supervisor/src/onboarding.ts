import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GlobalConfig } from '@agent-os/core';

const configPath = join(homedir(), '.agent-os', 'config.json');

export function resetModelCache(): void {
  modelCache = undefined;
}

type Provider = 'fireworks' | 'zai';

interface OnboardingInput {
  provider: Provider;
  apiKey: string;
  defaultModel: string;
}

interface ModelEntry {
  id: string;
  supportsTools: boolean;
  serverless: boolean;
  contextLength?: number;
}

interface ModelCache {
  fetchedAt: number;
  models: ModelEntry[];
}

let modelCache: ModelCache | undefined;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isConfigured(): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

export async function readGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return null;
  }
}

export async function onboard(input: OnboardingInput): Promise<void> {
  const config: GlobalConfig = {
    provider: input.provider,
    apiKey: input.apiKey,
    defaultModel: input.defaultModel,
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
}

export async function updateGlobalConfig(patch: {
  provider?: Provider;
  apiKey?: string;
  defaultModel?: string;
  reminders?: string[];
}): Promise<GlobalConfig> {
  const current = await readGlobalConfig();
  if (!current) {
    throw new Error('Not configured');
  }
  if (patch.provider !== undefined) {
    current.provider = patch.provider;
  }
  if (patch.apiKey !== undefined && patch.apiKey !== '') {
    current.apiKey = patch.apiKey;
  }
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

  const config = await readGlobalConfig();
  if (!config) {
    return { models: [], warning: 'Not configured' };
  }

  if (config.provider === 'zai') {
    // z.ai has no list-models endpoint; keep in sync with the coding plan's
    // current GLM lineup.
    const entries: ModelEntry[] = [
      {
        id: 'GLM-5.3',
        supportsTools: true,
        serverless: true,
        contextLength: 1000000,
      },
      {
        id: 'GLM-5.3-Flash',
        supportsTools: true,
        serverless: true,
        contextLength: 1000000,
      },
      {
        id: 'GLM-5.2',
        supportsTools: true,
        serverless: true,
        contextLength: 1000000,
      },
      {
        id: 'GLM-4.7',
        supportsTools: true,
        serverless: true,
        contextLength: 200000,
      },
      {
        id: 'GLM-4.6',
        supportsTools: true,
        serverless: true,
        contextLength: 200000,
      },
    ];
    modelCache = { fetchedAt: now, models: entries };
    return { models: entries };
  }

  try {
    const res = await fetch(
      'https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200',
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`Fireworks API returned ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    const models =
      (data as { models?: Array<Record<string, unknown>> }).models ?? [];
    const entries: ModelEntry[] = models
      .map((m) => ({
        id: String(m.id ?? m.name ?? ''),
        supportsTools: Boolean(
          m.supportsTools ?? m.supports_tool_calls ?? false,
        ),
        serverless: Boolean(m.supportsServerless ?? false),
        ...(typeof m.contextLength === 'number' && {
          contextLength: m.contextLength,
        }),
      }))
      .filter((m) => m.supportsTools && m.serverless);
    modelCache = { fetchedAt: now, models: entries };
    return { models: entries };
  } catch (err) {
    const warning = (err as Error).message ?? String(err);
    return { models: [], warning };
  }
}
