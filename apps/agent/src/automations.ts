import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Automation,
  AutomationStore,
  Tool,
  ToolContext,
} from '@agent-os/core';
import { Cron } from 'croner';
import type { McpConnection } from './mcp.js';
import { myPort } from './registry.js';

export type { Automation, AutomationStore };

const MAX_SUMMARY_LEN = 2000;

function automationsPath(homeDir: string): string {
  return join(homeDir, 'automations.json');
}

export async function loadAutomations(
  homeDir: string,
): Promise<AutomationStore> {
  try {
    const raw = await readFile(automationsPath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'automations' in parsed &&
      Array.isArray((parsed as AutomationStore).automations)
    ) {
      return parsed as AutomationStore;
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { automations: [] };
    }
    console.warn('Failed to load automations', err);
  }
  return { automations: [] };
}

// Serializes automations.json writes per process; concurrent tmp+rename
// would race and throw ENOENT, same pattern as thread.ts.
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

export function saveAutomations(
  homeDir: string,
  store: AutomationStore,
): Promise<void> {
  return enqueueWrite(async () => {
    const path = automationsPath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
    await rename(tmp, path);
  });
}

export interface AutomationSchedulerDeps {
  homeDir: string;
  agentId: string;
  mcpConnections: McpConnection[];
  isBusy: () => boolean;
  buildContext: (signal?: AbortSignal) => ToolContext;
}

export interface AutomationRunResult {
  ran: boolean;
  summary?: string;
}

export interface AutomationScheduler {
  start: () => Promise<void>;
  stop: () => void;
  list: () => Promise<Automation[]>;
  upsert: (automation: Automation) => Promise<Automation>;
  remove: (id: string) => Promise<boolean>;
  runNow: (id: string) => Promise<AutomationRunResult>;
  setMcpConnections: (connections: McpConnection[]) => void;
}

function findTool(
  connections: McpConnection[],
  name: string,
): { tool: Tool; conn: McpConnection } | undefined {
  for (const conn of connections) {
    const tool = conn.tools.find((t) => t.spec.name === name);
    if (tool) return { tool, conn };
  }
  return undefined;
}

function resolveArgs(
  args: Record<string, unknown>,
  cursor: string | undefined,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === '{{cursor}}') {
      resolved[key] = cursor ?? '';
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// Extract a new cursor from tool output. Tries JSON.parse first, searching
// for the max numeric ts-like value. Falls back to regex over raw text.
// Never compares lexicographically, only by Number(ts).
function extractCursor(output: string): string | undefined {
  let best: number | undefined;
  let bestRaw: string | undefined;

  const consider = (raw: string): void => {
    const n = Number(raw);
    if (!Number.isNaN(n)) {
      if (best === undefined || n > best) {
        best = n;
        bestRaw = raw;
      }
    }
  };

  try {
    const parsed = JSON.parse(output) as unknown;
    collectNumericTs(parsed, consider);
  } catch {
    // not JSON, fall through to regex
  }

  const re = /"ts"\s*:\s*"(\d+(?:\.\d+)?)"/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = re.exec(output)) !== null) {
    if (match[1]) consider(match[1]);
  }

  return bestRaw;
}

function collectNumericTs(
  node: unknown,
  consider: (raw: string) => void,
): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectNumericTs(item, consider);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'ts') {
      if (typeof value === 'number') {
        consider(String(value));
      } else if (typeof value === 'string') {
        consider(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      collectNumericTs(value, consider);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

export function createAutomationScheduler(
  deps: AutomationSchedulerDeps,
): AutomationScheduler {
  const jobs = new Map<string, Cron>();
  const inFlight = new Set<string>();
  let running = false;
  let mcpConnections = deps.mcpConnections;

  async function persistUpdate(
    id: string,
    patch: Partial<Automation>,
  ): Promise<Automation | undefined> {
    const store = await loadAutomations(deps.homeDir);
    const idx = store.automations.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    const existing = store.automations[idx];
    if (!existing) return undefined;
    const updated: Automation = {
      ...existing,
      ...patch,
    };
    store.automations[idx] = updated;
    await saveAutomations(deps.homeDir, store);
    return updated;
  }

  // Reload the automation by id from the store so each tick sees the
  // persisted cursor, not a stale closure copy.
  async function loadById(id: string): Promise<Automation | undefined> {
    const store = await loadAutomations(deps.homeDir);
    return store.automations.find((a) => a.id === id);
  }

  async function runAutomation(automation: Automation): Promise<{
    summary: string;
    newCursor: string | undefined;
    novelty: boolean;
  }> {
    // Wake-up mode: no tool bound, just wake the agent with the prompt.
    if (!automation.tool) {
      return {
        summary: automation.prompt ?? '',
        newCursor: undefined,
        novelty: true,
      };
    }
    const resolvedArgs = resolveArgs(automation.args ?? {}, automation.cursor);
    const found = findTool(mcpConnections, automation.tool);
    if (!found) {
      return {
        summary: `Tool "${automation.tool}" not found in connected MCP servers`,
        newCursor: automation.cursor,
        novelty: false,
      };
    }
    const ctx = deps.buildContext();
    const result = await found.tool.execute(resolvedArgs, ctx);
    const output = result.output;
    const newCursor = extractCursor(output);
    const oldCursor = automation.cursor;
    const novelty = newCursor !== undefined && newCursor !== oldCursor;
    const summary = truncate(output, MAX_SUMMARY_LEN);
    return { summary, newCursor, novelty };
  }

  async function deliverInbox(
    automation: Automation,
    summary: string,
  ): Promise<void> {
    const port = await myPort(deps.agentId);
    if (!port) {
      console.warn(
        `Automation "${automation.id}": cannot resolve own port, skipping delivery`,
      );
      return;
    }
    const message = `[automation: ${automation.name}]\n${summary}`;
    const taskId = `automation-${automation.id}-${Date.now()}`;
    try {
      const res = await fetch(`http://localhost:${port}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fromAgentId: deps.agentId,
          taskId,
          message,
        }),
      });
      if (!res.ok && res.status !== 202) {
        console.warn(
          `Automation "${automation.id}": inbox delivery returned ${res.status}`,
        );
      }
    } catch (err) {
      console.warn(`Automation "${automation.id}": inbox delivery failed`, err);
    }
  }

  // Reloads the automation by id from the store before running, so the
  // cursor is always current. Guards against overlapping runs per id.
  async function executeRun(id: string): Promise<{ summary: string }> {
    if (inFlight.has(id)) {
      return { summary: 'skipped, run already in progress' };
    }
    inFlight.add(id);
    try {
      const automation = await loadById(id);
      if (!automation) {
        return { summary: 'automation not found' };
      }
      const { summary, newCursor, novelty } = await runAutomation(automation);
      const now = new Date().toISOString();

      if (novelty && automation.delivery === 'inbox') {
        if (deps.isBusy()) {
          await persistUpdate(id, {
            ...(newCursor !== undefined ? { cursor: newCursor } : {}),
            lastRunAt: now,
            lastSummary: 'delivery skipped, agent busy',
          });
          return { summary: 'delivery skipped, agent busy' };
        }
        await deliverInbox(automation, summary);
      }

      await persistUpdate(id, {
        ...(newCursor !== undefined ? { cursor: newCursor } : {}),
        lastRunAt: now,
        lastSummary: truncate(summary, MAX_SUMMARY_LEN),
      });

      return { summary };
    } finally {
      inFlight.delete(id);
    }
  }

  function scheduleJob(automation: Automation): void {
    const existing = jobs.get(automation.id);
    if (existing) {
      existing.stop();
      jobs.delete(automation.id);
    }
    if (!automation.enabled) return;
    const job = new Cron(automation.cron, () => {
      void executeRun(automation.id).catch((err) => {
        console.error(`Automation "${automation.id}" run failed`, err);
      });
    });
    jobs.set(automation.id, job);
  }

  return {
    async start() {
      if (running) return;
      running = true;
      const store = await loadAutomations(deps.homeDir);
      for (const a of store.automations) {
        try {
          scheduleJob(a);
        } catch (err) {
          console.error(
            `Automation "${a.id}" has invalid cron "${a.cron}", skipping`,
            err,
          );
        }
      }
    },

    stop() {
      for (const job of jobs.values()) {
        job.stop();
      }
      jobs.clear();
      running = false;
    },

    async list() {
      const store = await loadAutomations(deps.homeDir);
      return store.automations;
    },

    async upsert(automation: Automation) {
      const store = await loadAutomations(deps.homeDir);
      const idx = store.automations.findIndex((a) => a.id === automation.id);
      if (idx >= 0) {
        store.automations[idx] = automation;
      } else {
        store.automations.push(automation);
      }
      await saveAutomations(deps.homeDir, store);
      scheduleJob(automation);
      return automation;
    },

    async remove(id: string) {
      const store = await loadAutomations(deps.homeDir);
      const idx = store.automations.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      store.automations.splice(idx, 1);
      await saveAutomations(deps.homeDir, store);
      const job = jobs.get(id);
      if (job) {
        job.stop();
        jobs.delete(id);
      }
      return true;
    },

    async runNow(id: string) {
      const automation = await loadById(id);
      if (!automation) return { ran: false };
      const { summary } = await executeRun(id);
      return { ran: true, summary };
    },

    setMcpConnections(connections: McpConnection[]) {
      mcpConnections = connections;
    },
  };
}
