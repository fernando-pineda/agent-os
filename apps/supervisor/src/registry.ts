import { execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  AgentAvatar,
  AgentConfig,
  AgentInfo,
  AgentStatus,
} from '@agent-os/core';
import {
  ensureWorkspaceUser,
  homeDirForWorkspace,
  userExists,
  usernameForWorkspace,
} from '@agent-os/sandbox';
import { uninstallLaunchdAgent } from './launchd.js';

export const AGENTS_ROOT = join(homedir(), '.agent-os', 'agents');
const REGISTRY_PATH = join(homedir(), '.agent-os', 'registry.json');

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

export interface CreateAgentInput {
  name: string;
  group?: string | undefined;
  workspace?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  sandboxed?: boolean | undefined;
  avatar?: AgentAvatar | undefined;
  instructions?: string | undefined;
  plugins?: string[] | undefined;
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
  needsSudo?: boolean | undefined;
  command?: string | undefined;
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
  patch: {
    name?: string | undefined;
    group?: string | undefined;
    role?: string | undefined;
    model?: string | undefined;
    workspace?: string | undefined;
    sandboxed?: boolean | undefined;
    avatar?: AgentAvatar | undefined;
    instructions?: string | undefined;
    plugins?: string[] | undefined;
    reminders?: string[] | undefined;
  },
): Promise<AgentConfig | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;

  if (patch.name !== undefined) config.name = patch.name;
  if (patch.group !== undefined) config.group = patch.group;
  if (patch.role !== undefined) config.role = patch.role;
  if (patch.model !== undefined) config.model = patch.model;
  if (patch.sandboxed !== undefined) config.sandboxed = patch.sandboxed;
  if (patch.avatar !== undefined) config.avatar = patch.avatar;
  if (patch.instructions !== undefined)
    config.instructions = patch.instructions;
  if (patch.plugins !== undefined) config.plugins = patch.plugins;
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
  await stopAgent(registry, id);

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
  // Also drop the supervisor-owned dev-home (thread, memory, outbox, usage)
  // so a recreated agent with the same id starts clean. Only dev-homes under
  // .agent-os are touched; real workspace user homes are never removed.
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
  if (input.model) config.model = input.model;
  if (input.sandboxed) config.sandboxed = input.sandboxed;
  if (input.avatar) config.avatar = input.avatar;
  if (input.instructions) config.instructions = input.instructions;
  if (input.plugins) config.plugins = input.plugins;
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

  try {
    await ensureWorkspaceUser(workspace);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.warn(
      `Workspace user for ${workspace} not created (${message}); using degraded dev home`,
    );
  }

  const port = allocatePort(registry);
  const entry: RegistryEntry = {
    id,
    port,
    pid: 0,
    status: 'starting',
  };
  registry.agents.push(entry);
  await saveRegistry(registry);

  const spawnResult = await spawnAgentProcess(registry, id, workspace);
  if (spawnResult.error) {
    return { error: spawnResult.error };
  }

  return {
    agent: toAgentInfo(config, entry.status, defaultModel),
  };
}

export async function startAgent(
  registry: Registry,
  id: string,
): Promise<AgentInfo | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;
  const workspace = config.workspace ?? config.id;
  const entry = getOrCreateEntry(registry, id);
  entry.status = 'starting';
  entry.manualStop = false;
  await saveRegistry(registry);
  const spawnResult = await spawnAgentProcess(registry, id, workspace);
  if (spawnResult.error) {
    return toAgentInfo(config, 'error', 'unknown');
  }
  return toAgentInfo(config, entry.status, 'unknown');
}

export async function stopAgent(
  registry: Registry,
  id: string,
): Promise<AgentInfo | null> {
  const config = await readAgentConfig(id);
  if (!config) return null;
  const entry = getOrCreateEntry(registry, id);

  const pids = await findAgentPids(entry);
  if (entry.pid > 0) {
    pids.add(entry.pid);
  }

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
  return toAgentInfo(config, 'stopped', 'unknown');
}

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

function runCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error) => {
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
    child.unref();
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
    child.unref();
  });
}

export async function reconcileOnBoot(registry: Registry): Promise<void> {
  registry.agents = (await loadRegistry()).agents;
  for (const entry of registry.agents) {
    entry.status = 'stopped';
    entry.pid = 0;
  }
  await saveRegistry(registry);
}

export function getOrCreateEntry(
  registry: Registry,
  id: string,
): RegistryEntry {
  let entry = registry.agents.find((a) => a.id === id);
  if (!entry) {
    entry = {
      id,
      port: allocatePort(registry),
      pid: 0,
      status: 'stopped',
    };
    registry.agents.push(entry);
  }
  return entry;
}

function allocatePort(registry: Registry): number {
  const base = 9100;
  const used = new Set(registry.agents.map((a) => a.port));
  let port = base;
  while (used.has(port)) {
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

  const entry = getOrCreateEntry(registry, id);
  const workspaceHome = homeDirForWorkspace(workspace);
  const username = usernameForWorkspace(workspace);
  const exists = await userExists(workspace);
  const canSudo = await sudoAvailable();
  const runningAsRoot = process.getuid?.() === 0;
  const useWorkspaceUser = exists && (runningAsRoot || canSudo);

  let effectiveHome: string;
  let spawnOptions: {
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: ['ignore', number, number];
    cwd?: string;
    uid?: number;
  };

  if (useWorkspaceUser) {
    effectiveHome = workspaceHome;
    spawnOptions = {
      env: {
        ...process.env,
        AGENT_ID: id,
        AGENT_PORT: String(entry.port),
        HOME: workspaceHome,
        AGENT_OS_HOME: workspaceHome,
      },
      detached: true,
      stdio: ['ignore', 0, 0],
      cwd: workspaceHome,
    };
  } else {
    const devHome = join(homedir(), '.agent-os', 'dev-homes', workspace);
    try {
      await access(devHome);
      effectiveHome = devHome;
    } catch {
      await mkdir(devHome, { recursive: true });
      effectiveHome = devHome;
    }
    if (runningAsRoot || canSudo) {
      console.warn(
        `Workspace user ${username} missing; using degraded dev home ${effectiveHome}`,
      );
    }
    spawnOptions = {
      env: {
        ...process.env,
        AGENT_ID: id,
        AGENT_PORT: String(entry.port),
        AGENT_OS_HOME: effectiveHome,
      },
      detached: true,
      stdio: ['ignore', 0, 0],
      cwd: effectiveHome,
    };
  }

  const outFd = await open(logPath, 'a');
  const errFd = await open(logPath, 'a');
  spawnOptions.stdio = ['ignore', outFd.fd, errFd.fd];

  let child: ReturnType<typeof spawn>;
  if (useWorkspaceUser && (runningAsRoot || canSudo)) {
    child = spawn(
      'sudo',
      ['-u', username, process.execPath, agentDistPath],
      spawnOptions,
    );
  } else {
    child = spawn(process.execPath, [agentDistPath], spawnOptions);
  }

  child.unref();
  if (child.pid) {
    entry.pid = child.pid;
    entry.status = 'starting';
    entry.lastSeen = new Date().toISOString();
    await saveRegistry(registry);
  }
  await Promise.all([outFd.close(), errFd.close()]);
  return {};
}

export function toAgentInfo(
  config: AgentConfig,
  status: AgentStatus,
  defaultModel: string,
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
  if (config.reminders) {
    info.reminders = config.reminders;
  }
  return info;
}

export function buildSysadminctlCommand(workspace: string): string {
  const username = usernameForWorkspace(workspace);
  const homeDir = homeDirForWorkspace(workspace);
  return `sudo sysadminctl -addUser ${username} -fullName "agent-os workspace ${workspace}" -password "<generate>" -home ${homeDir} -adminUser false`;
}

function sudoAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', 'true'], (error) => {
      resolve(error === null);
    });
  });
}
