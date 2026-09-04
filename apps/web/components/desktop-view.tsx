'use client';

import { ExternalLinkIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';

type DesktopViewProps = {
  desktopUrl?: string;
  port?: number;
};

function resolveDesktopUrl(
  desktopUrl: string | undefined,
  port: number | undefined,
): string | undefined {
  if (desktopUrl !== undefined) return desktopUrl;
  if (port === undefined) return undefined;
  return `https://localhost:${port}`;
}

export function DesktopView({
  desktopUrl,
  port,
}: DesktopViewProps): ReactElement {
  const resolvedDesktopUrl = resolveDesktopUrl(desktopUrl, port);

  if (resolvedDesktopUrl === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Desktop is unavailable for this agent.
      </div>
    );
  }

  const openDesktop = (): void => {
    window.open(resolvedDesktopUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
        <p>
          If the desktop doesn&apos;t load,{' '}
          <a
            href={resolvedDesktopUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open desktop to accept the certificate"
            className="text-zinc-200 underline underline-offset-2 hover:text-white"
          >
            click here
          </a>{' '}
          to accept the certificate, then refresh.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openDesktop}
          aria-label="Open desktop in a new tab"
          className="shrink-0 text-zinc-300 hover:bg-zinc-800 hover:text-white"
        >
          <ExternalLinkIcon />
          Fullscreen
        </Button>
      </div>
      <iframe
        src={resolvedDesktopUrl}
        title="Agent desktop"
        className="h-full min-h-0 w-full flex-1 border-0"
        allow="autoplay; clipboard-read; clipboard-write; microphone; camera; fullscreen"
        allowFullScreen
      />
    </div>
  );
}
