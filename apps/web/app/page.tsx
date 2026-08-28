'use client';

import { useEffect, useState } from 'react';
import { AgentProvider } from '@/components/agent-context';
import { ChatShell } from '@/components/chat-shell';
import { Onboarding } from '@/components/onboarding';
import { getOnboardingStatus } from '@/lib/api';

export default function Home() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    getOnboardingStatus()
      .then((status) => setConfigured(status.configured))
      .catch(() => setConfigured(false));
  }, []);

  if (configured === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-500">
        Loading...
      </div>
    );
  }

  return (
    <AgentProvider>
      {configured ? (
        <ChatShell />
      ) : (
        <Onboarding onDone={() => setConfigured(true)} />
      )}
    </AgentProvider>
  );
}
