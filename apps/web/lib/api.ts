import type { UIMessage } from '@ai-sdk/react';
import type {
  AgentInfo,
  AgentsResponse,
  CreateAgentPayload,
  ModelItem,
  ModelsResponse,
  OnboardingPayload,
  OnboardingStatus,
} from '@/lib/types';

const BASE = '/backend';

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
  await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
}

export async function stopAgent(id: string): Promise<void> {
  await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
}

export async function getMessages(agentId: string): Promise<UIMessage[]> {
  const res = await fetch(`${BASE}/api/agents/${agentId}/messages`);
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  return res.json();
}

export function subscribeAgentEvents(
  onSnapshot: (agents: AgentInfo[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = `${BASE}/api/agents/events`;
  const source = new EventSource(url);

  source.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data) as AgentInfo[];
      onSnapshot(data);
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
