import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RegistryEntry {
  id: string;
  port: number;
  pid: number;
}

export interface Registry {
  agents: RegistryEntry[];
}

const REGISTRY_PATH = join(homedir(), '.agent-os', 'registry.json');

export async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'agents' in parsed) {
      return parsed as Registry;
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { agents: [] };
    }
    console.warn('Failed to read registry', err);
  }
  return { agents: [] };
}

export async function findPortFor(
  agentId: string,
): Promise<number | undefined> {
  const registry = await readRegistry();
  return registry.agents.find((a) => a.id === agentId)?.port;
}

export async function myPort(agentId: string): Promise<number | undefined> {
  // The registry file is the source of truth; the supervisor writes it and the
  // health poller reads it, so prefer it over AGENT_PORT env to avoid mismatch.
  const registryPort = await findPortFor(agentId);
  if (registryPort !== undefined) return registryPort;
  const envPort = process.env.AGENT_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
