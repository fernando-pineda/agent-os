import type { UIMessage } from '@ai-sdk/react';
import type {
  AgentInfo,
  AgentsResponse,
  AgentTool,
  AgentToolsResponse,
  Automation,
  AutomationsResponse,
  CreateAgentPayload,
  CreateAutomationPayload,
  GlobalConfigStatus,
  McpServerConfig,
  McpServersResponse,
  McpStatusResponse,
  ModelItem,
  ModelsResponse,
  OnboardingPayload,
  OnboardingStatus,
  RunAutomationResponse,
  SubagentConfig,
  SubagentsResponse,
  UpdateAgentPayload,
  UpdateAutomationPayload,
  UpdateConfigPayload,
} from '@/lib/types';

// Resolve the supervisor base URL. In the browser, derive it from the page
// host so a remote deployment (e.g. EC2) works without code changes; the
// supervisor runs on the same host on port 8787. Override with
// NEXT_PUBLIC_SUPERVISOR_URL when it lives elsewhere. Direct (not the Next
// rewrite) because the rewrite buffers SSE and breaks events.
function resolveBase(): string {
  if (process.env.NEXT_PUBLIC_SUPERVISOR_URL) {
    return process.env.NEXT_PUBLIC_SUPERVISOR_URL;
  }
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `http://${window.location.hostname}:8787`;
  }
  return 'http://localhost:8787';
}

const BASE = resolveBase();

export const SUPERVISOR_BASE = BASE;

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return fetchJson<OnboardingStatus>(`${BASE}/api/onboarding/status`);
}

export async function postOnboarding(
  payload: OnboardingPayload,
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`${BASE}/api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function getModels(): Promise<ModelItem[]> {
  const res = await fetchJson<ModelsResponse>(`${BASE}/api/models`);
  return res.models;
}

export async function getGroups(): Promise<string[]> {
  const data = await fetchJson<{ groups: string[] }>(`${BASE}/api/groups`);
  return data.groups;
}

export async function createGroup(name: string): Promise<void> {
  await fetchJson(`${BASE}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function deleteGroup(name: string): Promise<void> {
  await fetchJson(`${BASE}/api/groups/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function getAgents(): Promise<AgentInfo[]> {
  const res = await fetchJson<AgentsResponse>(`${BASE}/api/agents`);
  return res.agents;
}

export async function createAgent(
  payload: CreateAgentPayload,
): Promise<AgentInfo> {
  return fetchJson<AgentInfo>(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function startAgent(id: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(id)}/start`,
    {
      method: 'POST',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Start failed: HTTP ${res.status}: ${text}`);
  }
}

export async function stopAgent(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Stop failed: HTTP ${res.status}: ${text}`);
  }
}

export async function deleteAgent(
  id: string,
  confirmName: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: confirmName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(
      body.error ? `Delete failed: ${body.error}` : `HTTP ${res.status}`,
    );
  }
}

export async function updateAgent(
  id: string,
  payload: UpdateAgentPayload,
): Promise<AgentInfo> {
  return fetchJson<AgentInfo>(`${BASE}/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function getUsage(
  agentId: string,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const res = await fetch(`${BASE}/api/agents/${agentId}/usage`);
  if (!res.ok) throw new Error(`usage failed: ${res.status}`);
  return res.json();
}

export async function getMessages(agentId: string): Promise<UIMessage[]> {
  const res = await fetch(`${BASE}/api/agents/${agentId}/messages`);
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  return res.json();
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  const res = await fetchJson<McpServersResponse>(`${BASE}/api/mcp`);
  return res.servers;
}

export async function getMcpStatuses(): Promise<McpStatusResponse> {
  return fetchJson<McpStatusResponse>(`${BASE}/api/mcp/status`);
}

export async function createMcpServer(
  server: McpServerConfig,
): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
}

export async function updateMcpServer(
  name: string,
  patch: Partial<McpServerConfig>,
): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>(
    `${BASE}/api/mcp/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteMcpServer(name: string): Promise<void> {
  await fetchJson(`${BASE}/api/mcp/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function getSubagents(): Promise<SubagentConfig[]> {
  const res = await fetchJson<SubagentsResponse>(`${BASE}/api/subagents`);
  return res.subagents;
}

export async function createSubagent(
  config: SubagentConfig,
): Promise<SubagentConfig> {
  return fetchJson<SubagentConfig>(`${BASE}/api/subagents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function updateSubagent(
  name: string,
  patch: Partial<SubagentConfig>,
): Promise<SubagentConfig> {
  return fetchJson<SubagentConfig>(
    `${BASE}/api/subagents/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteSubagent(name: string): Promise<void> {
  await fetchJson(`${BASE}/api/subagents/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function getConfig(): Promise<GlobalConfigStatus> {
  return fetchJson<GlobalConfigStatus>(`${BASE}/api/config`);
}

export async function updateConfig(
  payload: UpdateConfigPayload,
): Promise<GlobalConfigStatus> {
  return fetchJson<GlobalConfigStatus>(`${BASE}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function subscribeAgentEvents(
  onSnapshot: (agents: AgentInfo[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = `${BASE}/api/agents/events`;
  const source = new EventSource(url);

  source.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data) as { agents?: AgentInfo[] };
      onSnapshot(parsed.agents ?? []);
    } catch (err) {
      onError?.(
        err instanceof Error ? err : new Error('Failed to parse agent events'),
      );
    }
  });

  source.addEventListener('error', () => {
    onError?.(new Error('Agent events SSE error'));
  });

  return () => source.close();
}

export function subscribeAgentMessages(
  agentId: string,
  onSnapshot: (messages: unknown[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = `${BASE}/api/agents/${encodeURIComponent(agentId)}/messages/stream`;
  const source = new EventSource(url);
  source.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data) as { messages?: unknown[] };
      onSnapshot(parsed.messages ?? []);
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err
          : new Error('Failed to parse message stream'),
      );
    }
  });
  source.addEventListener('error', () => {
    onError?.(new Error('Message stream SSE error'));
  });
  return () => source.close();
}

export async function getAutomations(agentId: string): Promise<Automation[]> {
  const res = await fetchJson<AutomationsResponse>(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/automations`,
  );
  return res.automations;
}

export async function createAutomation(
  agentId: string,
  payload: CreateAutomationPayload,
): Promise<Automation> {
  return fetchJson<Automation>(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/automations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export async function updateAutomation(
  agentId: string,
  automationId: string,
  payload: UpdateAutomationPayload,
): Promise<Automation> {
  return fetchJson<Automation>(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteAutomation(
  agentId: string,
  automationId: string,
): Promise<void> {
  await fetchJson(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}`,
    { method: 'DELETE' },
  );
}

export async function runAutomation(
  agentId: string,
  automationId: string,
): Promise<RunAutomationResponse> {
  return fetchJson<RunAutomationResponse>(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/automations/${encodeURIComponent(automationId)}/run`,
    { method: 'POST' },
  );
}

export async function getAgentTools(agentId: string): Promise<AgentTool[]> {
  const res = await fetchJson<AgentToolsResponse>(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/tools`,
  );
  return res.tools;
}

export function getSubagentStreamUrl(agentId: string): string {
  return `${BASE}/api/agents/${encodeURIComponent(agentId)}/subagents/stream`;
}

export async function stopSubagent(
  agentId: string,
  runId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(agentId)}/subagents/${encodeURIComponent(runId)}/stop`,
    {
      method: 'POST',
    },
  );
  if (!res.ok) throw new Error(`Stop failed: HTTP ${res.status}`);
}
