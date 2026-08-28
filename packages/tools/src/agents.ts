import type { Tool, ToolResult } from '@agent-os/core';

const SUPERVISOR_BASE = 'http://localhost:8787';

interface AgentListItem {
  id: string;
  name: string;
  status: string;
  model: string;
  group?: string;
  role?: string;
  workspace?: string;
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
  return out;
}

export const agentList: Tool = {
  spec: {
    name: 'agent_list',
    description: 'List all agents managed by the supervisor',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
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

      const list = isAgentListResponse(data)
        ? data.agents.filter(isAgentObject)
        : Array.isArray(data)
          ? data.filter(isAgentObject)
          : [];
      return {
        ok: true,
        output: JSON.stringify(list.map(compactAgent), null, 2),
      };
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
        model: { type: 'string' },
      },
      required: ['name'],
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name : '';
    const payload: Record<string, unknown> = {};
    if (name) payload.name = name;
    if (typeof args.group === 'string' && args.group)
      payload.group = args.group;
    if (typeof args.workspace === 'string' && args.workspace)
      payload.workspace = args.workspace;
    if (typeof args.role === 'string' && args.role) payload.role = args.role;
    if (typeof args.model === 'string' && args.model)
      payload.model = args.model;

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

    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        output:
          'nothing to update: pass at least one of name, group, role, model, workspace, sandboxed',
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
      return { ok: true, output: `Updated agent ${agentId}.\n${body}` };
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
