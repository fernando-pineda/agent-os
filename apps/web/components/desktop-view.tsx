'use client';

import { ExternalLinkIcon, XIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';

type DesktopViewProps = {
  desktopUrl?: string;
  port?: number;
};

export function DesktopView({ desktopUrl }: DesktopViewProps): ReactElement {
  if (!desktopUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Desktop is unavailable for this agent.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <iframe
        src={desktopUrl}
        title="Agent desktop"
        className="h-full min-h-0 w-full flex-1 border-0"
        allow="autoplay; clipboard-read; clipboard-write; microphone; camera; fullscreen"
        allowFullScreen
      />
    </div>
  );
}
