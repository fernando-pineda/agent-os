'use client';

import { AgentProvider } from '@/components/agent-context';
import { ChatShell } from '@/components/chat-shell';

export default function Home() {
  return (
    <AgentProvider>
      <ChatShell />
    </AgentProvider>
  );
}
