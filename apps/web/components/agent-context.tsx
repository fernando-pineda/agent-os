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
  subscribeAgentEvents,
} from '@/lib/api';
import type { AgentInfo, ModelItem } from '@/lib/types';

export type AgentUsage = { inputTokens: number; outputTokens: number };

type AgentContextValue = {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  agents: AgentInfo[];
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
  const [agents, setAgents] = useState<AgentInfo[]>([]);
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
    getAgents().then(setAgents).catch(console.error);
    getModels().then(setModels).catch(console.error);
    refreshGroups();
    const unsubscribe = subscribeAgentEvents(
      (snapshot) => setAgents(snapshot),
      (error) => console.error(error),
    );
    return unsubscribe;
  }, [refreshGroups]);

  const value = useMemo<AgentContextValue>(
    () => ({
      selectedAgentId,
      setSelectedAgentId: set,
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

export function useModelsFeed(): { models: ModelItem[] } {
  return { models: useContext(AgentContext).models };
}

export function useGroupsFeed(): {
  groups: string[];
  refreshGroups: () => void;
} {
  const ctx = useContext(AgentContext);
  return { groups: ctx.groups, refreshGroups: ctx.refreshGroups };
}
