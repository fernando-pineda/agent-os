'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { getAgents, subscribeAgentEvents } from '@/lib/api';
import type { AgentInfo } from '@/lib/types';

type AgentContextValue = {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  agents: AgentInfo[];
  // Live "thinking" preview per agent while streaming; cleared on finish.
  livePreview: Record<string, string>;
  setLivePreview: (agentId: string, text: string) => void;
  clearLivePreview: (agentId: string) => void;
};

const AgentContext = createContext<AgentContextValue>({
  selectedAgentId: null,
  setSelectedAgentId: () => {},
  agents: [],
  livePreview: {},
  setLivePreview: () => {},
  clearLivePreview: () => {},
});

export function AgentProvider({ children }: { children: ReactNode }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [livePreview, setLive] = useState<Record<string, string>>({});
  const set = useCallback((id: string | null) => setSelectedAgentId(id), []);

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
    const unsubscribe = subscribeAgentEvents(
      (snapshot) => setAgents(snapshot),
      (error) => console.error(error),
    );
    return unsubscribe;
  }, []);

  return (
    <AgentContext.Provider
      value={{
        selectedAgentId,
        setSelectedAgentId: set,
        agents,
        livePreview,
        setLivePreview,
        clearLivePreview,
      }}
    >
      {children}
    </AgentContext.Provider>
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
