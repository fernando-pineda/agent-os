'use client';

import { Loader2Icon, MenuIcon, PanelLeftCloseIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useAgentSelection, useAgentsFeed } from '@/components/agent-context';
import { AgentsPanel } from '@/components/agents-panel';
import { Thread } from '@/components/assistant-ui/thread';
import { DesktopView } from '@/components/desktop-view';
import { SubagentPanel } from '@/components/subagent-panel';
import { Button } from '@/components/ui/button';
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@/components/ui/tabs';
import { avatarImagePath, avatarTileBackground } from '@/lib/avatars';
import { RuntimeProvider } from '@/lib/runtime';
import type { AgentInfo } from '@/lib/types';

type ChatTab = 'chat' | 'desktop';

type AgentWithDesktopPort = {
  desktopPort: number;
};

function hasDesktopPort(
  agent: AgentInfo,
): agent is AgentInfo & AgentWithDesktopPort {
  return 'desktopPort' in agent && typeof agent.desktopPort === 'number';
}

export function ChatShell(): ReactElement {
  const agentContext = useAgentSelection();
  const { selectedAgentId } = agentContext;
  const agents = useAgentsFeed();
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ChatTab>('chat');
  const desktopPort =
    selectedAgent !== undefined && hasDesktopPort(selectedAgent)
      ? selectedAgent.desktopPort
      : undefined;
  const desktopUrl =
    'desktopUrl' in agentContext && typeof agentContext.desktopUrl === 'string'
      ? agentContext.desktopUrl
      : undefined;

  const containerStatus = selectedAgent?.containerStatus;

  useEffect((): void => {
    if (selectedAgentId === null || desktopPort === undefined) {
      setActiveTab('chat');
    }
  }, [desktopPort, selectedAgentId]);

  const handleTabChange = (value: string | null): void => {
    if (value === 'chat' || value === 'desktop') {
      setActiveTab(value);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      <div className="absolute top-3 left-3 z-20 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSidebarOpen(true)}
          className="text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <MenuIcon className="size-5" />
        </Button>
      </div>

      <aside
        className={`fixed inset-y-0 left-0 z-30 w-[280px] flex-shrink-0 transform border-r border-zinc-800 bg-zinc-900 transition-transform md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-end border-b border-zinc-800 px-3 py-2 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(false)}
              className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <PanelLeftCloseIcon className="size-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-hidden">
            <AgentsPanel />
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex flex-1 flex-col overflow-hidden md:ml-0">
        <div className="flex-1 overflow-hidden">
          {!selectedAgentId ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-600">
              Pick an agent from the sidebar
            </div>
          ) : selectedAgent?.status === 'stopped' ? (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              {selectedAgent.avatar ? (
                <div
                  className="size-20 rounded-2xl"
                  style={{
                    background: avatarTileBackground(
                      selectedAgent.avatar.color,
                    ),
                  }}
                >
                  <img
                    src={avatarImagePath(selectedAgent.avatar.character)}
                    alt=""
                    className="size-full object-contain p-2 grayscale"
                  />
                </div>
              ) : null}
              <p className="text-sm text-zinc-500">Your agent is turned off.</p>
            </div>
          ) : (
            <RuntimeProvider key={selectedAgentId} agentId={selectedAgentId}>
              {containerStatus === 'pulling' ||
              containerStatus === 'starting' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <Loader2Icon className="size-6 animate-spin text-zinc-500" />
                  <p className="text-sm text-zinc-500">
                    {containerStatus === 'pulling'
                      ? 'Pulling Docker image, this may take a few minutes on first run...'
                      : 'Starting container...'}
                  </p>
                </div>
              ) : containerStatus === 'failed' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <p className="text-sm text-red-400">
                    Container failed to start. Check that Docker Desktop is
                    running.
                  </p>
                </div>
              ) : desktopPort === undefined ? (
                <Thread />
              ) : (
                <Tabs
                  value={activeTab}
                  onValueChange={handleTabChange}
                  className="flex h-full flex-col"
                >
                  <TabsList className="shrink-0 px-2">
                    <TabsTab value="chat">Chat</TabsTab>
                    <TabsTab value="desktop">Desktop</TabsTab>
                    <TabsIndicator />
                  </TabsList>
                  <TabsPanel
                    value="chat"
                    className="min-h-0 flex-1 overflow-hidden"
                  >
                    <Thread />
                  </TabsPanel>
                  <TabsPanel
                    value="desktop"
                    className="min-h-0 flex-1 overflow-hidden"
                  >
                    <DesktopView desktopUrl={desktopUrl} port={desktopPort} />
                  </TabsPanel>
                </Tabs>
              )}
            </RuntimeProvider>
          )}
        </div>
      </main>
      <SubagentPanel agentId={selectedAgentId} />
    </div>
  );
}
