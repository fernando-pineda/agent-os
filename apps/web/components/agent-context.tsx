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
};

const AgentContext = createContext<AgentContextValue>({
  selectedAgentId: null,
  setSelectedAgentId: () => {},
  agents: [],
});

export function AgentProvider({ children }: { children: ReactNode }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const set = useCallback((id: string | null) => setSelectedAgentId(id), []);

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
      value={{ selectedAgentId, setSelectedAgentId: set, agents }}
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
