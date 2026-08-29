import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

const REGISTRY_PATH = join(homedir(), '.agent-os', 'registry.json');

interface RegistryEntry {
  id: string;
  port: number;
}

interface RegistryFile {
  agents: RegistryEntry[];
}

async function resolveOwnPort(agentId: string): Promise<number | undefined> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('agents' in parsed))
      return undefined;
    const agents = (parsed as RegistryFile).agents;
    if (!Array.isArray(agents)) return undefined;
    const entry = agents.find(
      (a) => typeof a === 'object' && a !== null && a.id === agentId,
    );
    return entry?.port;
  } catch {
    return undefined;
  }
}

function errorResult(err: unknown): ToolResult {
  return {
    ok: false,
    output: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

function agentServerError(status: number, body: string): ToolResult {
  return {
    ok: false,
    output: `agent server ${status}: ${body.slice(0, 300)}`,
    isError: true,
  };
}

async function agentBase(ctx: ToolContext): Promise<string | ToolResult> {
  const port = await resolveOwnPort(ctx.agentId);
  if (!port) {
    return {
      ok: false,
      output: `could not resolve own agent port from ${REGISTRY_PATH}`,
      isError: true,
    };
  }
  return `http://localhost:${port}`;
}

export const automationList: Tool = {
  spec: {
    name: 'automation_list',
    description:
      'List all cron automations configured for this agent, including their schedules, target tools, and last run summaries.',
    parameters: { type: 'object', properties: {} },
  },

  async execute(
    _args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const base = await agentBase(ctx);
      if (typeof base !== 'string') return base;
      const res = await fetch(`${base}/automations`);
      const body = await res.text();
      if (!res.ok) return agentServerError(res.status, body);
      return { ok: true, output: body };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const automationCreate: Tool = {
  spec: {
    name: 'automation_create',
    description:
      'Create a cron automation that wakes the agent on a schedule by delivering a prompt to its inbox; the agent then acts using its connected MCP plugins. Use it for recurring tasks like checking Slack for new mentions every few minutes. A prompt is required so the agent knows what to do when woken. Advanced: optionally bind a specific MCP tool to poll directly (no LLM) using tool + args with the "{{cursor}}" placeholder for cursor-based polling.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable label for this automation.',
        },
        cron: {
          type: 'string',
          description:
            'Standard 5-field cron expression, e.g. "*/5 * * * *" for every 5 minutes.',
        },
        prompt: {
          type: 'string',
          description:
            'The instruction delivered to the agent inbox on each run, e.g. "Check Slack for new mentions and summarize them". Required.',
        },
        tool: {
          type: 'string',
          description:
            'Optional. Full MCP tool name in <server>__<tool> format for direct tool polling instead of a plain wake-up.',
        },
        args: {
          type: 'object',
          description:
            'Optional arguments for the bound tool. Use the string "{{cursor}}" where the last-seen cursor goes.',
        },
        delivery: {
          type: 'string',
          enum: ['inbox', 'silent'],
          description:
            'inbox (default) wakes the agent with the result; silent stores it without waking.',
        },
        enabled: {
          type: 'boolean',
          description:
            'Whether the automation starts active. Defaults to true.',
        },
      },
      required: ['name', 'cron', 'prompt'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, output: 'name is required', isError: true };
    const cron = typeof args.cron === 'string' ? args.cron.trim() : '';
    if (!cron) return { ok: false, output: 'cron is required', isError: true };
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!prompt && !tool)
      return {
        ok: false,
        output: 'prompt is required (unless binding a tool)',
        isError: true,
      };

    const payload: Record<string, unknown> = { name, cron };
    if (prompt) payload.prompt = prompt;
    if (tool) payload.tool = tool;
    if (
      args.args !== undefined &&
      typeof args.args === 'object' &&
      args.args !== null
    ) {
      payload.args = args.args;
    }
    const delivery = args.delivery;
    if (delivery === 'inbox' || delivery === 'silent')
      payload.delivery = delivery;
    if (typeof args.enabled === 'boolean') payload.enabled = args.enabled;

    try {
      const base = await agentBase(ctx);
      if (typeof base !== 'string') return base;
      const res = await fetch(`${base}/automations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      if (!res.ok) return agentServerError(res.status, body);
      return { ok: true, output: `Created automation "${name}".\n${body}` };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const automationUpdate: Tool = {
  spec: {
    name: 'automation_update',
    description:
      'Update an existing cron automation. Pass the id and any fields to change; omitted fields keep their current values.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        cron: { type: 'string' },
        prompt: { type: 'string' },
        tool: { type: 'string' },
        args: { type: 'object' },
        delivery: { type: 'string', enum: ['inbox', 'silent'] },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { ok: false, output: 'id is required', isError: true };

    const payload: Record<string, unknown> = {};
    if (typeof args.name === 'string' && args.name.trim())
      payload.name = args.name.trim();
    if (typeof args.cron === 'string' && args.cron.trim())
      payload.cron = args.cron.trim();
    if (typeof args.prompt === 'string' && args.prompt.trim())
      payload.prompt = args.prompt.trim();
    if (typeof args.tool === 'string' && args.tool.trim())
      payload.tool = args.tool.trim();
    if (
      args.args !== undefined &&
      typeof args.args === 'object' &&
      args.args !== null
    ) {
      payload.args = args.args;
    }
    if (args.delivery === 'inbox' || args.delivery === 'silent')
      payload.delivery = args.delivery;
    if (typeof args.enabled === 'boolean') payload.enabled = args.enabled;

    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        output:
          'nothing to update: pass at least one of name, cron, tool, args, delivery, enabled',
        isError: true,
      };
    }

    try {
      const base = await agentBase(ctx);
      if (typeof base !== 'string') return base;
      const res = await fetch(`${base}/automations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      if (!res.ok) return agentServerError(res.status, body);
      return { ok: true, output: `Updated automation ${id}.\n${body}` };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const automationDelete: Tool = {
  spec: {
    name: 'automation_delete',
    description:
      'Delete a cron automation. This stops the schedule and removes the automation.',
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
    if (!id) return { ok: false, output: 'id is required', isError: true };
    try {
      const base = await agentBase(ctx);
      if (typeof base !== 'string') return base;
      const res = await fetch(`${base}/automations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const body = await res.text();
      if (!res.ok) return agentServerError(res.status, body);
      return { ok: true, output: `Deleted automation ${id}.` };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const automationRun: Tool = {
  spec: {
    name: 'automation_run',
    description:
      'Trigger an automation immediately, outside its cron schedule. Returns the tool result right away.',
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
    if (!id) return { ok: false, output: 'id is required', isError: true };
    try {
      const base = await agentBase(ctx);
      if (typeof base !== 'string') return base;
      const res = await fetch(
        `${base}/automations/${encodeURIComponent(id)}/run`,
        {
          method: 'POST',
        },
      );
      const body = await res.text();
      if (!res.ok) return agentServerError(res.status, body);
      return { ok: true, output: body };
    } catch (err) {
      return errorResult(err);
    }
  },
};
