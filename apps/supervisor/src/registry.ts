import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  AgentAvatar,
  AgentConfig,
  AgentInfo,
  AgentStatus,
  ContainerStatus,
} from '@agent-os/core';
import { uninstallLaunchdAgent } from './launchd.js';
import { listMcpServers } from './mcps.js';
import { listModels } from './onboarding.js';

export const AGENTS_ROOT = join(homedir(), '.agent-os', 'agents');
const REGISTRY_PATH = join(homedir(), '.agent-os', 'registry.json');
// MCP plugins activated on every new agent unless the creator unchecks them.
const DEFAULT_PLUGINS = ['open-computer-use'];
const DEFAULT_KASM_IMAGE = 'kasmweb/ubuntu-jammy-desktop:1.19.0';
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_PULL_TIMEOUT_MS = 300_000;
const KASM_READINESS_TIMEOUT_MS = 30_000;
const KASM_READINESS_REQUEST_TIMEOUT_MS = 2_000;
const KASM_READINESS_RETRY_DELAY_MS = 250;

export interface RegistryEntry {
  id: string;
  port: number;
  pid: number;
  status: AgentStatus;
  lastSeen?: string | undefined;
  currentTaskId?: string | undefined;
  // Set when the user explicitly requested this agent to stop. Prevents the
  // health poller from resurrecting a killed process as online.
  manualStop?: boolean | undefined;
  vncPort?: number | undefined;
  containerId?: string | undefined;
  vncPassword?: string | undefined;
  containerStatus?: ContainerStatus | undefined;
}

export interface Registry {
  agents: RegistryEntry[];
}

export function createRegistry(): Registry {
  return { agents: [] };
}

export async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const registry = parsed as Registry;
    return { agents: registry.agents ?? [] };
  } catch {
    return createRegistry();
  }
}

export async function saveRegistry(registry: Registry): Promise<void> {
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

export async function listAgentConfigs(): Promise<AgentConfig[]> {
  try {
    const entries = await readdir(AGENTS_ROOT, { withFileTypes: true });
    const configs: AgentConfig[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = join(AGENTS_ROOT, entry.name, 'config.json');
      try {
        const raw = await readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as AgentConfig;
        configs.push(parsed);
      } catch {
        // Skip malformed directories
      }
    }
    return configs;
  } catch {
    return [];
  }
}

export async function readAgentConfig(id: string): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(join(AGENTS_ROOT, id, 'config.json'), 'utf-8');
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateId(name: string, existing: Set<string>): string {
  let base = slugify(name);
  if (!base) base = 'agent';
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

export function validateWorkspace(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (/^[a-z0-9-]{1,32}$/.test(value)) return null;
  return 'workspace must be 1-32 lowercase letters, numbers, or hyphens';
}

// Look up a model's vision capability from the provider's model list.
async function resolveModelVision(
  modelId: string,
): Promise<boolean | undefined> {
  try {
    const { models } = await listModels();
    const lower = modelId.toLowerCase();
    // Model ids vary in case across sources (config vs catalog).
    return models.find((m) => m.id.toLowerCase() === lower)?.supportsVision;
  } catch {
    return undefined;
  }
}

export interface CreateAgentInput {
  name: string;
  group?: string | undefined;
  workspace?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  sandboxed?: boolean | undefined;
  sandboxType?: AgentConfig['sandboxType'];
  kasmImage?: string | undefined;
  avatar?: AgentAvatar | undefined;
  instructions?: string | undefined;
  plugins?: string[] | undefined;
  subagents?: string[] | undefined;
  reminders?: string[] | undefined;
  git?: {
    userName?: string;
    userEmail?: string;
    credential?: string;
    sshKeyPath?: string;
  };
}

export interface CreateAgentResult {
  agent?: AgentInfo | undefined;
  error?: string | undefined;
}

export interface AgentConfigPatch {
  name?: string | undefined;
  group?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  workspace?: string | undefined;
  sandboxed?: boolean | undefined;
  sandboxType?: AgentConfig['sandboxType'];
  kasmImage?: string | undefined;
  avatar?: AgentAvatar | undefined;
  instructions?: string | undefined;
  plugins?: string[] | undefined;
  subagents?: string[] | undefined;
  reminders?: string[] | undefined;
}

export async function writeAgentConfig(config: AgentConfig): Promise<void> {
  await writeFile(
    join(AGENTS_ROOT, config.id, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

export async function updateAgentConfig(
  id: string,
  patch: AgentConfigPatch,
): Promise<AgentConfig | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;

  if (patch.name !== undefined) config.name = patch.name;
  if (patch.group !== undefined) config.group = patch.group;
  if (patch.role !== undefined) config.role = patch.role;
  if (patch.model !== undefined) {
    config.model = patch.model;
    const vision = await resolveModelVision(patch.model);
    if (vision !== undefined) config.supportsVision = vision;
  }
  if (patch.sandboxed !== undefined) config.sandboxed = patch.sandboxed;
  if (patch.sandboxType !== undefined) config.sandboxType = patch.sandboxType;
  if (patch.kasmImage !== undefined) config.kasmImage = patch.kasmImage;
  if (patch.avatar !== undefined) config.avatar = patch.avatar;
  if (patch.instructions !== undefined)
    config.instructions = patch.instructions;
  if (patch.plugins !== undefined) config.plugins = patch.plugins;
  if (patch.subagents !== undefined) config.subagents = patch.subagents;
  if (patch.reminders !== undefined) config.reminders = patch.reminders;
  if (patch.workspace !== undefined) {
    const validationError = validateWorkspace(patch.workspace);
    if (validationError) {
      throw new Error(validationError);
    }
    config.workspace = patch.workspace;
  }

  await writeAgentConfig(config);
  return config;
}

export async function deleteAgent(
  registry: Registry,
  id: string,
): Promise<void> {
  const config = await readAgentConfig(id);
  const entry = registry.agents.find((candidate) => candidate.id === id);
  await stopAgent(registry, id);
  if (
    config?.sandboxType !== 'docker-desktop' &&
    entry?.containerId !== undefined
  ) {
    try {
      await stopDockerContainer(id);
    } catch (err) {
      console.warn(
        `stopDockerContainer(${id}) during delete failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    await uninstallLaunchdAgent(id);
  } catch (err) {
    console.warn(
      `uninstallLaunchdAgent(${id}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    await promisify(execFile)('tmux', ['kill-session', '-t', `agent-os-${id}`]);
  } catch {
    // Session may already be gone.
  }

  const index = registry.agents.findIndex((a) => a.id === id);
  if (index >= 0) {
    registry.agents.splice(index, 1);
  }
  await saveRegistry(registry);

  await rm(join(AGENTS_ROOT, id), { recursive: true, force: true });
  // Also drop the dev-home (thread, memory, outbox, usage) so a recreated
  // agent with the same id starts clean.
  await rm(join(homedir(), '.agent-os', 'dev-homes', id), {
    recursive: true,
    force: true,
  });
}

export async function createAgent(
  registry: Registry,
  input: CreateAgentInput,
  defaultModel: string,
): Promise<CreateAgentResult> {
  const configs = await listAgentConfigs();
  const existing = new Set(configs.map((c) => c.id));
  const id = generateId(input.name, existing);
  const workspace = input.workspace ?? id;
  const validationError = validateWorkspace(input.workspace);
  if (validationError) {
    return { error: validationError };
  }

  const homeDir = join(AGENTS_ROOT, id);
  await mkdir(homeDir, { recursive: true });

  const config: AgentConfig = {
    id,
    name: input.name,
    createdAt: new Date().toISOString(),
  };
  if (input.group) config.group = input.group;
  if (input.workspace) config.workspace = input.workspace;
  if (input.role) config.role = input.role;
  if (input.model) {
    config.model = input.model;
    const vision = await resolveModelVision(input.model);
    if (vision !== undefined) config.supportsVision = vision;
  }
  if (input.sandboxed) config.sandboxed = input.sandboxed;
  if (input.sandboxType !== undefined) config.sandboxType = input.sandboxType;
  if (input.kasmImage !== undefined) config.kasmImage = input.kasmImage;
  if (input.avatar) config.avatar = input.avatar;
  if (input.instructions) config.instructions = input.instructions;
  // Apply default plugins only when they exist in the MCP catalog; otherwise
  // creation would 400 on names that are not configured on this host.
  const configured = new Set((await listMcpServers()).map((s) => s.name));
  const defaults = DEFAULT_PLUGINS.filter((p) => configured.has(p));
  const plugins = [...new Set([...(input.plugins ?? []), ...defaults])];
  if (plugins.length > 0) config.plugins = plugins;
  if (input.reminders) config.reminders = input.reminders;
  if (input.git) {
    config.git = {
      ...(input.git.userName ? { userName: input.git.userName } : {}),
      ...(input.git.userEmail ? { userEmail: input.git.userEmail } : {}),
      ...(input.git.credential ? { credential: input.git.credential } : {}),
      ...(input.git.sshKeyPath ? { sshKeyPath: input.git.sshKeyPath } : {}),
    };
  }

  await writeAgentConfig(config);

  // Use getOrCreateEntry so the port is assigned atomically and reused by
  // spawnAgentProcess below, guaranteeing the spawned process binds the exact
  // port recorded in the registry.
  const entry = await getOrCreateEntry(registry, id);
  entry.status = 'starting';
  entry.pid = 0;
  if (config.sandboxType === 'docker-desktop') {
    entry.containerStatus = 'pulling';
  }
  await saveRegistry(registry);

  void spawnAgentProcess(registry, id, workspace).catch((err) => {
    console.error(`Background spawn failed for ${id}:`, err);
  });

  return {
    agent: toAgentInfo(config, entry.status, defaultModel, entry),
  };
}

export async function startAgent(
  registry: Registry,
  id: string,
  defaultModel = 'unknown',
): Promise<AgentInfo | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;
  const workspace = config.workspace ?? config.id;
  const entry = await getOrCreateEntry(registry, id);
  entry.status = 'starting';
  entry.manualStop = false;
  if (config.sandboxType === 'docker-desktop') {
    entry.containerStatus = 'pulling';
  }
  await saveRegistry(registry);
  void spawnAgentProcess(registry, id, workspace).catch((err) => {
    console.error(`Background spawn failed for ${id}:`, err);
  });
  return toAgentInfo(config, entry.status, defaultModel, entry);
}

export async function stopAgent(
  registry: Registry,
  id: string,
  defaultModel = 'unknown',
): Promise<AgentInfo | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;
  const entry = await getOrCreateEntry(registry, id);

  await killAgentProcesses(entry, id);

  if (config.sandboxType === 'docker-desktop') {
    try {
      await stopDockerContainer(id);
    } catch (err) {
      console.warn(
        `stopDockerContainer(${id}) during stop failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    delete entry.containerId;
    delete entry.vncPort;
    delete entry.vncPassword;
    entry.containerStatus = 'none';
  }

  try {
    const hasSession = await runCommand('tmux', [
      'has-session',
      '-t',
      `agent-os-${id}`,
    ]);
    if (hasSession) {
      await runCommand('tmux', ['kill-session', '-t', `agent-os-${id}`]);
    }
  } catch {
    // Session may already be gone.
  }

  try {
    await uninstallLaunchdAgent(id);
  } catch (err) {
    console.warn(
      `uninstallLaunchdAgent(${id}) during stop failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  entry.pid = 0;
  entry.status = 'stopped';
  entry.manualStop = true;
  await saveRegistry(registry);
  return toAgentInfo(config, 'stopped', defaultModel, entry);
}

// Resolve the agent dist main.js path so pgrep can match it. Mirrors the
// candidate logic in spawnAgentProcess.
function agentDistPath(): string | null {
  const candidates = [
    fileURLToPath(new URL('../../agent/dist/main.js', import.meta.url)),
    fileURLToPath(
      new URL('../node_modules/@agent-os/agent/dist/main.js', import.meta.url),
    ),
  ];
  return candidates[0] ?? candidates[1] ?? null;
}

// Find pids listening on the entry port (lsof), plus the tmux pane pid, plus
// any node process whose command line matches the agent dist path filtered by
// AGENT_ID=<id>. This catches orphan processes even when the registry entry
// is stale or its port is wrong.
async function findAgentPids(entry: RegistryEntry): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    const stdout = await runCommandForOutput('lsof', [
      '-ti',
      `tcp:${entry.port}`,
      '-sTCP:LISTEN',
    ]);
    for (const line of stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
  } catch {
    // lsof may fail when no listener is present.
  }
  return pids;
}

// tmux pane pid for the agent session; the node child runs as the pane process.
async function findTmuxPid(id: string): Promise<number | undefined> {
  try {
    const stdout = await runCommandForOutput('tmux', [
      'list-panes',
      '-t',
      `agent-os-${id}`,
      '-F',
      '#{pid}',
    ]);
    const pid = Number.parseInt(stdout.trim(), 10);
    if (pid > 0 && pid !== process.pid) return pid;
  } catch {
    // Session may not exist.
  }
  return undefined;
}

// pgrep for node processes whose command line contains the agent dist main.js
// path, then filter by AGENT_ID env (env is not in the command line, so we
// inspect each pid's environment via ps -E).
async function findPgrepPids(id: string): Promise<Set<number>> {
  const pids = new Set<number>();
  const distPath = agentDistPath();
  if (!distPath) return pids;
  try {
    const stdout = await runCommandForOutput('pgrep', ['-f', distPath]);
    for (const line of stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (pid <= 0 || pid === process.pid) continue;
      const pidId = await extractAgentIdFromPid(pid);
      if (pidId === id) pids.add(pid);
    }
  } catch {
    // pgrep returns non-zero when no match.
  }
  return pids;
}

// All pids for an agent by id: entry port listener, tmux pane, and pgrep match.
export async function findAllAgentPids(
  entry: RegistryEntry | undefined,
  id: string,
): Promise<Set<number>> {
  const pids = new Set<number>();
  if (entry) {
    for (const pid of await findAgentPids(entry)) pids.add(pid);
  }
  const tmuxPid = await findTmuxPid(id);
  if (tmuxPid) pids.add(tmuxPid);
  for (const pid of await findPgrepPids(id)) pids.add(pid);
  if (entry?.pid && entry.pid > 0) pids.add(entry.pid);
  return pids;
}

// Kill all pids for an agent, wait, SIGKILL stragglers, then verify the port
// (if known) is actually freed. Centralizes the stop logic so deleteAgent and
// stopAgent share it.
export async function killAgentProcesses(
  entry: RegistryEntry | undefined,
  id: string,
): Promise<void> {
  const pids = await findAllAgentPids(entry, id);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }
  for (const pid of pids) {
    await waitForExit(pid, 5000);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
  if (entry) {
    await waitForPortFree(entry.port, 3000);
  }
}

// Wait until lsof reports no listener on the port, or timeout.
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port)) return;
    await sleep(200);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(200);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeKasmReadiness(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        rejectUnauthorized: false,
      },
      (response) => {
        response.on('error', (error) => {
          request.destroy(error);
        });
        if (timeout !== undefined) clearTimeout(timeout);
        response.resume();
        resolve();
      },
    );
    request.once('error', (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(error);
    });
    timeout = setTimeout(() => {
      request.destroy(
        new Error(`KasmVNC readiness request timed out on port ${port}`),
      );
    }, timeoutMs);
    request.end();
  });
}

async function waitForKasmReadiness(port: number): Promise<void> {
  const deadline = Date.now() + KASM_READINESS_TIMEOUT_MS;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    const timeoutMs = Math.min(
      KASM_READINESS_REQUEST_TIMEOUT_MS,
      deadline - Date.now(),
    );
    try {
      await probeKasmReadiness(port, timeoutMs);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(KASM_READINESS_RETRY_DELAY_MS, remainingMs));
  }

  const detail = lastError ? `: ${lastError.message}` : '';
  throw new Error(`KasmVNC readiness check timed out on port ${port}${detail}`);
}

function runCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        if (error.code === 1) {
          resolve(false);
        } else {
          reject(error);
        }
      } else {
        resolve(true);
      }
    });
  });
}

function runCommandForOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const child = execFile(command, args, (error, output) => {
      if (error && error.code !== 0 && error.code !== 1) {
        reject(error);
        return;
      }
      stdout = output ?? stdout;
      resolve(stdout);
    });
    child.stdout?.on('data', (data) => {
      stdout += String(data);
    });
  });
}

function runDockerCommand(
  args: string[],
  allowMissing: boolean,
): Promise<string> {
  return runDockerCommandWithTimeout(
    args,
    allowMissing,
    DOCKER_COMMAND_TIMEOUT_MS,
  );
}

function runDockerCommandWithTimeout(
  args: string[],
  allowMissing: boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (
            allowMissing &&
            error.code === 1 &&
            /no such container/i.test(stderr)
          ) {
            resolve(stdout);
            return;
          }
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function dockerContainerName(agentId: string): string {
  return `agentos-${agentId.toLowerCase()}`;
}

async function removeDockerContainer(agentId: string): Promise<void> {
  await runDockerCommand(['rm', '-f', dockerContainerName(agentId)], true);
}

async function stopDockerContainer(agentId: string): Promise<void> {
  await runDockerCommand(['stop', dockerContainerName(agentId)], true);
}

export async function reconcileOnBoot(registry: Registry): Promise<void> {
  registry.agents = (await loadRegistry()).agents;
  for (const entry of registry.agents) {
    entry.status = 'stopped';
    entry.pid = 0;
    const config = await readAgentConfig(entry.id);
    if (config?.sandboxType === 'docker-desktop') {
      try {
        await removeDockerContainer(entry.id);
      } catch (err) {
        console.warn(
          `removeDockerContainer(${entry.id}) during boot reconciliation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      delete entry.containerId;
      delete entry.vncPort;
      delete entry.vncPassword;
      entry.containerStatus = 'none';
    }
  }
  await saveRegistry(registry);
  await reapOrphanAgents(registry);
}

// On startup, kill agent processes whose config dir was deleted or whose id
// has no registry entry. Only processes matching the agent dist main.js path
// are considered, never unrelated node processes.
async function reapOrphanAgents(registry: Registry): Promise<void> {
  const knownIds = new Set(registry.agents.map((a) => a.id));
  const orphans = await findOrphanAgentIds();
  for (const id of orphans) {
    if (knownIds.has(id)) continue;
    const configExists = await readAgentConfig(id);
    if (configExists) continue;
    console.warn(`Reaping orphan agent process for ${id}`);
    await killAgentProcesses(undefined, id);
    try {
      await runCommand('tmux', ['kill-session', '-t', `agent-os-${id}`]);
    } catch {
      // Session may already be gone.
    }
  }
}

// pgrep for node processes running the agent dist main.js, then extract the
// AGENT_ID from each process command line. Returns ids of running agents.
async function findOrphanAgentIds(): Promise<string[]> {
  const distPath = agentDistPath();
  if (!distPath) return [];
  const ids: string[] = [];
  try {
    const stdout = await runCommandForOutput('pgrep', ['-f', distPath]);
    for (const line of stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (pid <= 0 || pid === process.pid) continue;
      const id = await extractAgentIdFromPid(pid);
      if (id) ids.push(id);
    }
  } catch {
    // pgrep returns non-zero when no match.
  }
  return ids;
}

// Read the process command line and environment, pull out AGENT_ID=<id>.
// macOS ps uses -E to show env; Linux ps uses the BSD-style 'e' modifier.
async function extractAgentIdFromPid(pid: number): Promise<string | undefined> {
  // macOS: ps -E -p <pid> -o command=
  const macId = await tryPsEnv(['-E', '-p', String(pid), '-o', 'command=']);
  if (macId) return macId;
  // Linux: ps -p <pid> -o command= e (BSD-style env modifier)
  const linuxId = await tryPsEnv(['-p', String(pid), '-o', 'command=', 'e']);
  if (linuxId) return linuxId;
  return undefined;
}

async function tryPsEnv(args: string[]): Promise<string | undefined> {
  try {
    const stdout = await runCommandForOutput('ps', args);
    const match = /AGENT_ID=([a-z0-9-]+)/.exec(stdout);
    if (match?.[1]) return match[1];
  } catch {
    // Process may have exited or flag unsupported.
  }
  return undefined;
}

export async function getOrCreateEntry(
  registry: Registry,
  id: string,
): Promise<RegistryEntry> {
  const existing = registry.agents.find((a) => a.id === id);
  if (existing) return existing;

  // No entry in this in-memory copy. Reload from disk so we see entries (and
  // ports) other concurrent writers (e.g. the status tracker tick) may have
  // just persisted, including one for this very id.
  const disk = await loadRegistry();

  // A concurrent writer may already have created this id on disk. Reuse that
  // entry verbatim so its port stays stable instead of allocating a new one.
  const diskEntry = disk.agents.find((a) => a.id === id);
  if (diskEntry) {
    // Merge any disk entries our in-memory copy lacks, then persist for
    // consistency and return the canonical entry.
    const seen = new Set(registry.agents.map((a) => a.id));
    for (const d of disk.agents) {
      if (!seen.has(d.id)) registry.agents.push(d);
    }
    await saveRegistry(registry);
    return registry.agents.find((a) => a.id === id)!;
  }

  // Truly new id: allocate against the fresh disk view so we never collide
  // with a port another writer just recorded, then persist so the port is
  // authoritative before we return.
  const port = await allocatePort(disk);
  const entry: RegistryEntry = {
    id,
    port,
    pid: 0,
    status: 'stopped',
  };
  const seen = new Set(registry.agents.map((a) => a.id));
  for (const d of disk.agents) {
    if (!seen.has(d.id)) registry.agents.push(d);
  }
  registry.agents.push(entry);
  await saveRegistry(registry);
  return entry;
}

// Probe whether a TCP port is actually free, not just absent from the registry.
// lsof is present on macOS and Linux; errors are treated as "assume free" so a
// missing lsof never blocks agent creation.
async function isPortFree(port: number): Promise<boolean> {
  try {
    const stdout = await runCommandForOutput('lsof', [
      '-ti',
      `tcp:${port}`,
      '-sTCP:LISTEN',
    ]);
    return stdout.trim().length === 0;
  } catch {
    return true;
  }
}

// Pick the smallest port that is neither in the registry nor actually bound.
// This skips ports held by orphan processes whose registry entry was lost.
async function allocatePort(registry: Registry): Promise<number> {
  const base = 9100;
  const used = new Set(registry.agents.map((a) => a.port));
  let port = base;
  while (used.has(port) || !(await isPortFree(port))) {
    port++;
  }
  return port;
}

async function allocateVncPort(registry: Registry): Promise<number> {
  const base = 6901;
  const used = new Set(registry.agents.map((a) => a.vncPort));
  let port = base;
  while (used.has(port) || !(await isPortFree(port))) {
    port++;
  }
  return port;
}

export function getAgentPort(
  registry: Registry,
  id: string,
): number | undefined {
  return registry.agents.find((a) => a.id === id)?.port;
}

interface DockerSpawnResult {
  containerId: string;
  vncPort: number;
  vncPassword: string;
}

async function spawnDockerContainer(
  agentId: string,
  vncPort: number,
  kasmImage: string,
): Promise<DockerSpawnResult> {
  const containerName = dockerContainerName(agentId);
  await removeDockerContainer(agentId);
  const vncPassword = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await runDockerCommand(['image', 'inspect', kasmImage], false);
  } catch {
    await runDockerCommandWithTimeout(
      ['pull', kasmImage],
      false,
      DOCKER_PULL_TIMEOUT_MS,
    );
  }
  let stdout: string;
  try {
    stdout = await runDockerCommand(
      [
        'run',
        '-d',
        '--rm',
        '--shm-size=512m',
        '-p',
        `127.0.0.1:${vncPort}:6901`,
        '-e',
        `VNC_PW=${vncPassword}`,
        '--name',
        containerName,
        kasmImage,
      ],
      false,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(vncPassword, '[redacted]'));
  }
  const containerId = stdout.trim().split(/\s+/)[0];
  if (!containerId) {
    throw new Error(`docker run returned no container id for ${agentId}`);
  }
  return { containerId, vncPort, vncPassword };
}

interface SpawnResult {
  error?: string;
}

async function spawnAgentProcess(
  registry: Registry,
  id: string,
  workspace: string,
): Promise<SpawnResult> {
  const homeDir = join(AGENTS_ROOT, id);
  const logPath = join(homeDir, 'agent.log');
  const candidates = [
    fileURLToPath(new URL('../../agent/dist/main.js', import.meta.url)),
    fileURLToPath(
      new URL('../node_modules/@agent-os/agent/dist/main.js', import.meta.url),
    ),
  ];
  let agentDistPath: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      agentDistPath = candidate;
      break;
    } catch {}
  }
  if (!agentDistPath) {
    return {
      error: `Agent entry not found in ${candidates.join(' or ')}. Build @agent-os/agent first.`,
    };
  }

  const entry = await getOrCreateEntry(registry, id);
  const config = await readAgentConfig(id);
  if (!config) {
    return { error: `Agent config not found for ${id}.` };
  }
  const devHome = join(homedir(), '.agent-os', 'dev-homes', workspace);
  await mkdir(devHome, { recursive: true });

  let dockerResult: DockerSpawnResult | undefined;
  if (config.sandboxType === 'docker-desktop') {
    try {
      await runDockerCommand(['info', '--format', '{{.ServerVersion}}'], false);
      entry.containerStatus = 'pulling';
      await saveRegistry(registry);
      const vncPort = await allocateVncPort(registry);
      entry.containerStatus = 'starting';
      await saveRegistry(registry);
      dockerResult = await spawnDockerContainer(
        id,
        vncPort,
        config.kasmImage ?? DEFAULT_KASM_IMAGE,
      );
      await waitForKasmReadiness(dockerResult.vncPort);
      entry.containerStatus = 'running';
    } catch (err) {
      entry.containerStatus = 'failed';
      if (dockerResult) {
        try {
          await stopDockerContainer(id);
        } catch (cleanupError) {
          console.warn(
            `stopDockerContainer(${id}) after container startup failure failed: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`,
          );
        }
      }
      dockerResult = undefined;
      console.error(
        `Docker container spawn failed for ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await saveRegistry(registry);
  }

  const spawnOptions: {
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: ['ignore', number, number];
    cwd: string;
  } = {
    env: {
      ...process.env,
      AGENT_ID: id,
      AGENT_PORT: String(entry.port),
      AGENT_OS_HOME: devHome,
    },
    detached: true,
    stdio: ['ignore', 0, 0],
    cwd: devHome,
  };
  if (dockerResult) {
    spawnOptions.env.AGENT_CONTAINER_NAME = dockerContainerName(id);
  }

  const outFd = await open(logPath, 'a');
  const errFd = await open(logPath, 'a');
  spawnOptions.stdio = ['ignore', outFd.fd, errFd.fd];

  const child = spawn(process.execPath, [agentDistPath], spawnOptions);

  child.unref();
  if (child.pid) {
    if (dockerResult) {
      entry.containerId = dockerResult.containerId;
      entry.vncPort = dockerResult.vncPort;
      entry.vncPassword = dockerResult.vncPassword;
    }
    entry.pid = child.pid;
    entry.status = 'starting';
    entry.lastSeen = new Date().toISOString();
    await saveRegistry(registry);
  } else if (dockerResult) {
    try {
      await stopDockerContainer(id);
    } catch (err) {
      console.warn(
        `stopDockerContainer(${id}) after process spawn failure failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  await Promise.all([outFd.close(), errFd.close()]);
  return {};
}

export function toAgentInfo(
  config: AgentConfig,
  status: AgentStatus,
  defaultModel: string,
  entry?: RegistryEntry,
): AgentInfo {
  const info: AgentInfo = {
    id: config.id,
    name: config.name,
    status,
    workspace: config.workspace ?? config.id,
    model: config.model ?? defaultModel,
    tmuxSession: `agent-os-${config.id}`,
  };
  if (config.group) {
    info.group = config.group;
  }
  if (config.role) {
    info.role = config.role;
  }
  if (config.avatar) {
    info.avatar = config.avatar;
  }
  if (config.instructions) {
    info.instructions = config.instructions;
  }
  if (config.plugins) {
    info.plugins = config.plugins;
  }
  if (config.subagents) {
    info.subagents = config.subagents;
  }
  if (config.reminders) {
    info.reminders = config.reminders;
  }
  if (config.sandboxType !== undefined) {
    info.sandboxType = config.sandboxType;
  }
  if (config.kasmImage !== undefined) {
    info.kasmImage = config.kasmImage;
  }
  if (entry?.vncPort !== undefined) {
    info.desktopPort = entry.vncPort;
  }
  if (entry?.containerStatus !== undefined) {
    info.containerStatus = entry.containerStatus;
  }
  return info;
}
