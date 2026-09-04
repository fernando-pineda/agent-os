import {
  AGENT_CHARACTERS,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '@agent-os/core';

const SUPERVISOR_BASE = 'http://localhost:8787';

const AVATAR_CHARACTER_DESC = `character (one of: ${AGENT_CHARACTERS.join(', ')})`;

interface AgentListItem {
  id: string;
  name: string;
  status: string;
  model: string;
  group?: string;
  role?: string;
  workspace?: string;
  instructions?: string;
  plugins?: string[];
}

function isAgentListResponse(value: unknown): value is { agents: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'agents' in value &&
    Array.isArray(value.agents)
  );
}

function isAgentObject(value: unknown): value is AgentListItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    'model' in value &&
    typeof value.model === 'string'
  );
}

function supervisorError(status: number, body: string): ToolResult {
  return { ok: false, output: `supervisor ${status}: ${body.slice(0, 300)}` };
}

function errorResult(err: unknown): ToolResult {
  return {
    ok: false,
    output: err instanceof Error ? err.message : String(err),
  };
}

function isAvatarObject(value: unknown): value is {
  character: string;
  color: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { character?: unknown; color?: unknown };
  return (
    typeof candidate.character === 'string' &&
    typeof candidate.color === 'string'
  );
}

// Extract the avatar from a PATCH /api/agents response so the caller can see
// the effective avatar after the supervisor silently drops invalid ones.
function parseUpdateResponse(
  body: string,
): { avatar?: { character: string; color: string } } | undefined {
  try {
    const data = JSON.parse(body) as unknown;
    if (typeof data !== 'object' || data === null) return undefined;
    const candidate = data as { avatar?: unknown };
    if (isAvatarObject(candidate.avatar)) {
      return { avatar: candidate.avatar };
    }
    return {};
  } catch {
    return undefined;
  }
}

function compactAgent(agent: AgentListItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    model: agent.model,
  };
  if (agent.group !== undefined) out.group = agent.group;
  if (agent.role !== undefined) out.role = agent.role;
  if (agent.workspace !== undefined) out.workspace = agent.workspace;
  if (agent.instructions !== undefined) out.instructions = agent.instructions;
  if (agent.plugins !== undefined) out.plugins = agent.plugins;
  return out;
}

export const agentList: Tool = {
  spec: {
    name: 'agent_list',
    description:
      'List agents you can contact. If you belong to a group, only that group is listed. If you are not in a group, all agents across all groups are listed, each tagged with its group. Each entry includes name, status, model, role, instructions (what it does) and plugins, so you can decide whether to call it.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  async execute(
    _args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/agents`);
      const body = await res.text();
      if (!res.ok) {
        return supervisorError(res.status, body);
      }

      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return {
          ok: false,
          output: `invalid JSON from supervisor: ${body.slice(0, 300)}`,
        };
      }

      let list = isAgentListResponse(data)
        ? data.agents.filter(isAgentObject)
        : Array.isArray(data)
          ? data.filter(isAgentObject)
          : [];

      // Group scoping: a grouped agent sees only its own group; an ungrouped
      // agent sees every group (group name is included per entry).
      let groupNote: string | undefined;
      if (ctx.group) {
        list = list.filter((a) => a.group === ctx.group);
        groupNote = `You only see agents in your group "${ctx.group}".`;
      } else {
        const groups = [
          ...new Set(
            list.map((a) => a.group).filter((g): g is string => Boolean(g)),
          ),
        ];
        if (groups.length > 0) {
          groupNote = `Groups present: ${groups.join(', ')}. You are not in a group, so you see all of them.`;
        }
      }

      const output = groupNote
        ? `${groupNote}\n${JSON.stringify(list.map(compactAgent), null, 2)}`
        : JSON.stringify(list.map(compactAgent), null, 2);
      return { ok: true, output };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const agentCreate: Tool = {
  spec: {
    name: 'agent_create',
    description: 'Create a new agent managed by the supervisor',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        group: { type: 'string' },
        workspace: { type: 'string' },
        role: { type: 'string' },
        model: {
          type: 'string',
          description:
            'Model for the new agent. Omit to inherit the calling agent model automatically.',
        },
        plugins: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of MCP servers to activate for the new agent (from mcp_list)',
        },
        avatar: {
          type: 'object',
          properties: {
            character: { type: 'string' },
            color: { type: 'string' },
          },
          description: `{ ${AVATAR_CHARACTER_DESC}, color (hex string e.g. #7c3aed) }`,
        },
        instructions: {
          type: 'string',
          description:
            'Operational instructions for the agent, injected into its system prompt every turn',
        },
        reminders: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Persistent reminders injected into the system prompt every turn',
        },
      },
      required: ['name', 'avatar'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name : '';
    const payload: Record<string, unknown> = {};
    if (name) payload.name = name;
    if (typeof args.group === 'string' && args.group)
      payload.group = args.group;
    if (typeof args.workspace === 'string' && args.workspace)
      payload.workspace = args.workspace;
    if (typeof args.role === 'string' && args.role) payload.role = args.role;
    // Inherit the calling agent model when omitted so parent and child match.
    if (typeof args.model === 'string' && args.model)
      payload.model = args.model;
    else if (ctx?.model) payload.model = ctx.model;
    if (
      Array.isArray(args.plugins) &&
      args.plugins.every((p) => typeof p === 'string')
    )
      payload.plugins = args.plugins;
    if (isAvatarObject(args.avatar)) {
      payload.avatar = args.avatar;
    }
    if (typeof args.instructions === 'string' && args.instructions)
      payload.instructions = args.instructions;
    if (
      Array.isArray(args.reminders) &&
      args.reminders.every((r) => typeof r === 'string')
    )
      payload.reminders = args.reminders;

    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      if (!res.ok) {
        return supervisorError(res.status, body);
      }

      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return {
          ok: false,
          output: `invalid JSON from supervisor: ${body.slice(0, 300)}`,
        };
      }

      const agent = isAgentObject(data)
        ? data
        : typeof data === 'object' &&
            data !== null &&
            'agent' in data &&
            isAgentObject(data.agent)
          ? data.agent
          : undefined;
      if (!agent) {
        return {
          ok: false,
          output: `unexpected response: ${body.slice(0, 300)}`,
        };
      }
      return {
        ok: true,
        output: `Created agent ${agent.id} "${agent.name}" (status ${agent.status}).`,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const agentUpdate: Tool = {
  spec: {
    name: 'agent_update',
    description: 'Update an existing agent managed by the supervisor',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        name: { type: 'string' },
        group: { type: 'string' },
        role: { type: 'string' },
        model: { type: 'string' },
        workspace: { type: 'string' },
        sandboxed: { type: 'boolean' },
        plugins: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Replace the agent's active MCP servers (from mcp_list). Empty array clears all.",
        },
        avatar: {
          type: 'object',
          properties: {
            character: { type: 'string' },
            color: { type: 'string' },
          },
          description: `{ ${AVATAR_CHARACTER_DESC}, color (hex string e.g. #7c3aed) }. Invalid avatars are silently dropped on update; the returned avatar reflects what stuck.`,
        },
        instructions: {
          type: 'string',
          description:
            'Operational instructions for the agent, injected into its system prompt every turn',
        },
        reminders: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Persistent reminders injected into the system prompt every turn. Empty array clears.',
        },
      },
      required: ['agentId'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const agentId = typeof args.agentId === 'string' ? args.agentId : '';
    const payload: Record<string, unknown> = {};
    if (typeof args.name === 'string' && args.name) payload.name = args.name;
    if (typeof args.group === 'string' && args.group)
      payload.group = args.group;
    if (typeof args.role === 'string' && args.role) payload.role = args.role;
    if (typeof args.model === 'string' && args.model)
      payload.model = args.model;
    if (typeof args.workspace === 'string' && args.workspace)
      payload.workspace = args.workspace;
    if (typeof args.sandboxed === 'boolean') payload.sandboxed = args.sandboxed;
    if (
      Array.isArray(args.plugins) &&
      args.plugins.every((p) => typeof p === 'string')
    )
      payload.plugins = args.plugins;
    if (isAvatarObject(args.avatar)) {
      payload.avatar = args.avatar;
    }
    if (typeof args.instructions === 'string' && args.instructions)
      payload.instructions = args.instructions;
    if (
      Array.isArray(args.reminders) &&
      args.reminders.every((r) => typeof r === 'string')
    )
      payload.reminders = args.reminders;

    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        output:
          'nothing to update: pass at least one of name, group, role, model, workspace, sandboxed, avatar, plugins, instructions, reminders',
      };
    }

    try {
      const res = await fetch(
        `${SUPERVISOR_BASE}/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.text();
      if (!res.ok) {
        return supervisorError(res.status, body);
      }
      // Surface the returned config so the caller sees the effective avatar,
      // since the supervisor silently drops invalid avatars on update.
      const parsed = parseUpdateResponse(body);
      const avatarLine = parsed?.avatar
        ? ` avatar=${JSON.stringify(parsed.avatar)}`
        : '';
      return {
        ok: true,
        output: `Updated agent ${agentId}.${avatarLine}\n${body}`,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
};

export const agentDelete: Tool = {
  spec: {
    name: 'agent_delete',
    description: 'Delete an agent managed by the supervisor',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        confirmName: { type: 'string' },
      },
      required: ['agentId', 'confirmName'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const agentId = typeof args.agentId === 'string' ? args.agentId : '';
    const confirmName =
      typeof args.confirmName === 'string' ? args.confirmName : '';

    let list: AgentListItem[] = [];
    try {
      const res = await fetch(`${SUPERVISOR_BASE}/api/agents`);
      const body = await res.text();
      if (!res.ok) {
        return supervisorError(res.status, body);
      }
      const data = JSON.parse(body) as unknown;
      list = isAgentListResponse(data)
        ? data.agents.filter(isAgentObject)
        : Array.isArray(data)
          ? data.filter(isAgentObject)
          : [];
    } catch (err) {
      return errorResult(err);
    }

    const found = list.find((a) => a.id === agentId);
    if (!found) {
      return { ok: false, output: `agent "${agentId}" not found` };
    }

    if (confirmName !== found.name) {
      return {
        ok: false,
        output: `refused: confirmName must be the agent's exact name "${found.name}". Ask the user to confirm the deletion by name before retrying.`,
      };
    }

    try {
      const res = await fetch(
        `${SUPERVISOR_BASE}/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: found.name }),
        },
      );
      const body = await res.text();
      if (!res.ok) {
        return supervisorError(res.status, body);
      }
      return {
        ok: true,
        output: `Deleted agent ${agentId} ("${found.name}").`,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
};
