'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getAgents,
  getGroups,
  getModels,
  SUPERVISOR_BASE,
  subscribeAgentEvents,
} from '@/lib/api';
import type { AgentInfo, ModelItem } from '@/lib/types';

export type AgentUsage = { inputTokens: number; outputTokens: number };

type AgentContextAgent = AgentInfo & { desktopUrl?: string };

type AgentContextValue = {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  agents: AgentContextAgent[];
  desktopUrl?: string;
  patchAgentStatus: (id: string, status: AgentInfo['status']) => void;
  // Live "thinking" preview per agent while streaming; cleared on finish.
  livePreview: Record<string, string>;
  setLivePreview: (agentId: string, text: string) => void;
  clearLivePreview: (agentId: string) => void;
  // Last reported token usage per agent, for context-left display.
  usage: Record<string, AgentUsage>;
  setUsage: (agentId: string, u: AgentUsage) => void;
  models: ModelItem[];
  groups: string[];
  refreshGroups: () => void;
  refreshModels: () => void;
};

const AgentContext = createContext<AgentContextValue>({
  selectedAgentId: null,
  setSelectedAgentId: () => {},
  agents: [],
  desktopUrl: undefined,
  patchAgentStatus: () => {},
  livePreview: {},
  setLivePreview: () => {},
  clearLivePreview: () => {},
  usage: {},
  setUsage: () => {},
  models: [],
  groups: [],
  refreshGroups: () => {},
  refreshModels: () => {},
});

export function AgentProvider({ children }: { children: ReactNode }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentContextAgent[]>([]);
  const [livePreview, setLive] = useState<Record<string, string>>({});
  const [usage, setUsageMap] = useState<Record<string, AgentUsage>>({});
  const [models, setModels] = useState<ModelItem[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  const refreshGroups = useCallback(() => {
    getGroups().then(setGroups).catch(console.error);
  }, []);
  const refreshModels = useCallback(() => {
    getModels().then(setModels).catch(console.error);
  }, []);
  const set = useCallback((id: string | null) => setSelectedAgentId(id), []);

  const addDesktopUrl = useCallback((agent: AgentInfo): AgentContextAgent => {
    if (agent.desktopPort === undefined) return agent;
    const desktopUrl = new URL(
      `${SUPERVISOR_BASE}/api/agents/${encodeURIComponent(agent.id)}/desktop/proxy/`,
    );
    desktopUrl.searchParams.set(
      'path',
      `api/agents/${encodeURIComponent(agent.id)}/desktop/proxy/websockify`,
    );
    desktopUrl.searchParams.set('resize', 'scale');
    return { ...agent, desktopUrl: desktopUrl.toString() };
  }, []);

  const setAgentSnapshot = useCallback(
    (snapshot: AgentInfo[]): void => {
      setAgents(snapshot.map(addDesktopUrl));
    },
    [addDesktopUrl],
  );

  const patchAgentStatus = useCallback(
    (id: string, status: AgentInfo['status']) => {
      setAgents((prev) =>
        prev.map((agent) => (agent.id === id ? { ...agent, status } : agent)),
      );
    },
    [],
  );

  const setUsage = useCallback((agentId: string, u: AgentUsage) => {
    setUsageMap((prev) => ({ ...prev, [agentId]: u }));
  }, []);

  const setLivePreview = useCallback((agentId: string, text: string) => {
    setLive((prev) => ({ ...prev, [agentId]: text }));
  }, []);

  const clearLivePreview = useCallback((agentId: string) => {
    setLive((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  }, []);

  useEffect(() => {
    getAgents().then(setAgentSnapshot).catch(console.error);
    getModels().then(setModels).catch(console.error);
    refreshGroups();
    const unsubscribe = subscribeAgentEvents(setAgentSnapshot, (error) =>
      console.error(error),
    );
    return unsubscribe;
  }, [refreshGroups, setAgentSnapshot]);

  const value = useMemo<AgentContextValue>(
    () => ({
      selectedAgentId,
      setSelectedAgentId: set,
      agents,
      desktopUrl: agents.find((agent) => agent.id === selectedAgentId)
        ?.desktopUrl,
      patchAgentStatus,
      livePreview,
      setLivePreview,
      clearLivePreview,
      usage,
      setUsage,
      models,
      groups,
      refreshGroups,
      refreshModels,
    }),
    [
      selectedAgentId,
      set,
      agents,
      patchAgentStatus,
      livePreview,
      setLivePreview,
      clearLivePreview,
      usage,
      setUsage,
      models,
      groups,
      refreshGroups,
      refreshModels,
    ],
  );

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}

export function useAgentSelection(): AgentContextValue {
  return useContext(AgentContext);
}

export function useAgentsFeed(): AgentInfo[] {
  return useContext(AgentContext).agents;
}

export function useLivePreview(): {
  livePreview: Record<string, string>;
  setLivePreview: (agentId: string, text: string) => void;
  clearLivePreview: (agentId: string) => void;
} {
  const ctx = useContext(AgentContext);
  return {
    livePreview: ctx.livePreview,
    setLivePreview: ctx.setLivePreview,
    clearLivePreview: ctx.clearLivePreview,
  };
}

export function useAgentUsage(): {
  usage: Record<string, AgentUsage>;
  setUsage: (agentId: string, u: AgentUsage) => void;
} {
  const ctx = useContext(AgentContext);
  return { usage: ctx.usage, setUsage: ctx.setUsage };
}

export function useModelsFeed(): {
  models: ModelItem[];
  refreshModels: () => void;
} {
  const ctx = useContext(AgentContext);
  return { models: ctx.models, refreshModels: ctx.refreshModels };
}

export function useGroupsFeed(): {
  groups: string[];
  refreshGroups: () => void;
} {
  const ctx = useContext(AgentContext);
  return { groups: ctx.groups, refreshGroups: ctx.refreshGroups };
}
