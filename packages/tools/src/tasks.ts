import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';

const STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'done',
];

interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

function tasksPath(homeDir: string): string {
  return join(homeDir, 'tasks.json');
}

// Serialize writes per home dir to avoid lost updates.
const writeQueues = new Map<string, Promise<void>>();

function writeQueue(homeDir: string): Promise<void> {
  let q = writeQueues.get(homeDir);
  if (!q) {
    q = Promise.resolve();
  }
  return q;
}

async function loadTasks(homeDir: string): Promise<TaskRecord[]> {
  try {
    const raw = await readFile(tasksPath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTaskRecord);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    typeof r.status === 'string' &&
    STATUSES.includes(r.status as TaskStatus) &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  );
}

function saveTasks(homeDir: string, tasks: TaskRecord[]): Promise<void> {
  const path = tasksPath(homeDir);
  const tmp = `${path}.tmp`;
  const run = async (): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf-8');
    await rename(tmp, path);
  };
  const next = writeQueue(homeDir).then(run);
  writeQueues.set(
    homeDir,
    next.catch(() => undefined),
  );
  return next;
}

function errorResult(err: unknown): ToolResult {
  return {
    ok: false,
    output: err instanceof Error ? err.message : String(err),
  };
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || 'task'}-${suffix}`;
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUSES.includes(value as TaskStatus);
}

export const taskList: Tool = {
  spec: {
    name: 'task_list',
    description:
      'List your tracked tasks. Optionally filter by status (open, in_progress, blocked, done). Returns a JSON array.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'done'],
        },
      },
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      let tasks = await loadTasks(ctx.homeDir);
      if (isStatus(args.status)) {
        tasks = tasks.filter((t) => t.status === args.status);
      }
      return { ok: true, output: JSON.stringify(tasks, null, 2) };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const taskCreate: Tool = {
  spec: {
    name: 'task_create',
    description:
      'Create a tracked task with a title. Optional status (default open), notes, and id (auto-generated slug from the title if omitted). Returns the created task as JSON.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'done'],
        },
        notes: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['title'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) return { ok: false, output: 'title is required' };

    const status: TaskStatus = isStatus(args.status) ? args.status : 'open';
    const notes = typeof args.notes === 'string' ? args.notes : undefined;
    const id =
      typeof args.id === 'string' && args.id.trim()
        ? args.id.trim()
        : slugify(title);

    try {
      const tasks = await loadTasks(ctx.homeDir);
      if (tasks.some((t) => t.id === id)) {
        return { ok: false, output: `duplicate task id: ${id}` };
      }
      const now = new Date().toISOString();
      const record: TaskRecord = {
        id,
        title,
        status,
        createdAt: now,
        updatedAt: now,
      };
      if (notes !== undefined) record.notes = notes;
      tasks.push(record);
      await saveTasks(ctx.homeDir, tasks);
      return { ok: true, output: JSON.stringify(record, null, 2) };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const taskUpdate: Tool = {
  spec: {
    name: 'task_update',
    description:
      'Update a tracked task by id. Pass any of title, status, notes to change; omitted fields keep their current values. Returns the updated task as JSON.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'done'],
        },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { ok: false, output: 'id is required' };

    try {
      const tasks = await loadTasks(ctx.homeDir);
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx < 0) return { ok: false, output: `task not found: ${id}` };

      const task = tasks[idx] as TaskRecord;
      if (typeof args.title === 'string' && args.title.trim()) {
        task.title = args.title.trim();
      }
      if (isStatus(args.status)) {
        task.status = args.status;
      }
      if (typeof args.notes === 'string') {
        task.notes = args.notes;
      }
      task.updatedAt = new Date().toISOString();

      await saveTasks(ctx.homeDir, tasks);
      return { ok: true, output: JSON.stringify(task, null, 2) };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const taskGet: Tool = {
  spec: {
    name: 'task_get',
    description: 'Get a single tracked task by id. Returns the task as JSON.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { ok: false, output: 'id is required' };

    try {
      const tasks = await loadTasks(ctx.homeDir);
      const task = tasks.find((t) => t.id === id);
      if (!task) return { ok: false, output: `task not found: ${id}` };
      return { ok: true, output: JSON.stringify(task, null, 2) };
    } catch (err) {
      return errorResult(err);
    }
  },
};
