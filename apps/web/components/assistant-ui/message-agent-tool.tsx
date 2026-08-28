'use client';

import type { DataMessagePartProps } from '@assistant-ui/react';
import { MailIcon, SendIcon } from 'lucide-react';

type MessageAgentData = {
  toAgentId: string;
  state: 'sending' | 'sent' | 'failed';
};

export const MessageAgentChip = ({ data }: DataMessagePartProps<unknown>) => {
  const d = data as MessageAgentData | undefined;
  const target = d?.toAgentId || 'agent';
  const label =
    d?.state === 'sending'
      ? `Sending a message to ${target}...`
      : d?.state === 'failed'
        ? `Message to ${target} failed`
        : `I sent a message to ${target}`;

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
        <SendIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
};

type InboxAgentData = {
  fromAgentId: string;
  reply: boolean;
};

export const InboxAgentChip = ({ data }: DataMessagePartProps<unknown>) => {
  const d = data as InboxAgentData | undefined;
  const from = d?.fromAgentId || 'agent';
  const label = d?.reply ? `${from} replied` : `Message from ${from}`;

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
        <MailIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
};
