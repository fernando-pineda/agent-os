'use client';

import { MenuIcon, PanelLeftCloseIcon } from 'lucide-react';
import { useState } from 'react';
import { useAgentSelection } from '@/components/agent-context';
import { AgentsPanel } from '@/components/agents-panel';
import { Thread } from '@/components/assistant-ui/thread';
import { Button } from '@/components/ui/button';
import { RuntimeProvider } from '@/lib/runtime';

export function ChatShell() {
  const { selectedAgentId } = useAgentSelection();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {/* Mobile sidebar toggle */}
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

      {/* Sidebar: agents only, one chat per agent */}
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

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main thread area: keyed by agent so each agent has one chat */}
      <main className="flex flex-1 flex-col overflow-hidden md:ml-0">
        <div className="flex-1 overflow-hidden">
          {selectedAgentId ? (
            <RuntimeProvider key={selectedAgentId} agentId={selectedAgentId}>
              <Thread />
            </RuntimeProvider>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-600">
              Pick an agent from the sidebar
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
