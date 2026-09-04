import type { Tool, ToolContext, ToolResult, ToolSpec } from '@agent-os/core';

const SUPERVISOR_BASE = 'http://localhost:8787';

type ToolArguments = Parameters<Tool['execute']>[0];

interface SubagentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

interface SubagentToolContext extends ToolContext {
  runSubagent?: (
    name: string,
    task: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

interface CompactSubagent {
  name: string;
  description: string;
  tools: string[];
}

function isSubagentConfig(value: object | null): value is SubagentConfig {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('description' in value) ||
    typeof value.description !== 'string' ||
    !('systemPrompt' in value) ||
    typeof value.systemPrompt !== 'string'
  ) {
    return false;
  }

  if (
    'model' in value &&
    value.model !== undefined &&
    typeof value.model !== 'string'
  ) {
    return false;
  }

  return !(
    'tools' in value &&
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      !value.tools.every((tool) => typeof tool === 'string'))
  );
}

function compactSubagent(subagent: SubagentConfig): CompactSubagent {
  return {
    name: subagent.name,
    description: subagent.description,
    tools: subagent.tools ?? [],
  };
}

function parseSubagentResponse(body: string): SubagentConfig[] {
  let parsed: object | null;
  try {
    const value = JSON.parse(body);
    parsed = typeof value === 'object' && value !== null ? value : null;
  } catch {
    throw new Error(`invalid JSON from supervisor: ${body.slice(0, 300)}`);
  }

  if (parsed === null) {
    throw new Error(
      `unexpected response from supervisor: ${body.slice(0, 300)}`,
    );
  }

  if (Array.isArray(parsed)) {
    return parsed.filter(isSubagentConfig);
  }

  if ('subagents' in parsed && Array.isArray(parsed.subagents)) {
    return parsed.subagents.filter(isSubagentConfig);
  }

  throw new Error(`unexpected response from supervisor: ${body.slice(0, 300)}`);
}

function errorResult(error: Error | string): ToolResult {
  return {
    ok: false,
    output: error instanceof Error ? error.message : error,
    isError: true,
  };
}

const subagentListSpec: ToolSpec = {
  name: 'subagent_list',
  description:
    'List available shared subagents that can be invoked with subagent_run. Each entry includes name, description, and allowed tools.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const subagentList: Tool = {
  spec: subagentListSpec,

  async execute(_args: ToolArguments, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const response = await fetch(`${SUPERVISOR_BASE}/api/subagents`);
      const body = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          output: `supervisor ${response.status}: ${body.slice(0, 300)}`,
          isError: true,
        };
      }

      const subagents = parseSubagentResponse(body);
      return {
        ok: true,
        output: JSON.stringify(subagents.map(compactSubagent)),
      };
    } catch (error) {
      return errorResult(error instanceof Error ? error : String(error));
    }
  },
};

const subagentRunSpec: ToolSpec = {
  name: 'subagent_run',
  description:
    "Run a shared subagent to handle a subtask. The subagent runs in-process with its own model, tools, and system prompt. Returns the subagent's final text response. Use this to delegate focused work that benefits from a specialized prompt or restricted toolset.",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      task: { type: 'string' },
    },
    required: ['name', 'task'],
  },
};

export const subagentRun: Tool = {
  spec: subagentRunSpec,

  async execute(
    args: ToolArguments,
    ctx: SubagentToolContext,
  ): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const task = typeof args.task === 'string' ? args.task.trim() : '';

    if (!name) {
      return { ok: false, output: 'name is required', isError: true };
    }
    if (!task) {
      return { ok: false, output: 'task is required', isError: true };
    }
    if (!ctx.runSubagent) {
      return {
        ok: false,
        output: 'Subagent runner not available',
        isError: true,
      };
    }

    try {
      const output = await ctx.runSubagent(name, task, ctx.signal);
      return { ok: true, output };
    } catch (error) {
      return errorResult(error instanceof Error ? error : String(error));
    }
  },
};
