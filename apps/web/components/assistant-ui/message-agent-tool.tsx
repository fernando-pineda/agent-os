'use client';

import type { DataMessagePartProps } from '@assistant-ui/react';
import { ArrowRightIcon, MailIcon, UserIcon } from 'lucide-react';
import { useAgentSelection, useAgentsFeed } from '@/components/agent-context';
import { avatarImagePath, avatarTileBackground } from '@/lib/avatars';
import type { AgentInfo } from '@/lib/types';

type MessageAgentData = {
  toAgentId: string;
  state: 'sending' | 'sent' | 'failed';
};

function AgentAvatarTile({ agent }: { agent: AgentInfo | undefined }) {
  if (!agent?.avatar) {
    return (
      <div className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
        <UserIcon
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
    );
  }
  return (
    <div
      className="size-6 shrink-0 rounded-lg"
      style={{ background: avatarTileBackground(agent.avatar.color) }}
    >
      <img
        src={avatarImagePath(agent.avatar.character)}
        alt=""
        className="size-full object-contain p-0.5"
      />
    </div>
  );
}

export const MessageAgentChip = ({ data }: DataMessagePartProps<unknown>) => {
  const d = data as MessageAgentData | undefined;
  const targetId = d?.toAgentId || 'agent';
  const agents = useAgentsFeed();
  const { selectedAgentId } = useAgentSelection();
  const sender = agents.find((a) => a.id === selectedAgentId);
  const recipient = agents.find((a) => a.id === targetId);
  const recipientName = recipient?.name ?? targetId;
  const label =
    d?.state === 'sending'
      ? `Sending message to ${recipientName}...`
      : d?.state === 'failed'
        ? `Failed to send message to ${recipientName}`
        : `Sent message to ${recipientName}`;

  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <AgentAvatarTile agent={sender} />
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        <AgentAvatarTile agent={recipient} />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
};

type InboxAgentData = {
  fromAgentId: string;
  reply: boolean;
};

export const InboxAgentChip = ({ data }: DataMessagePartProps<unknown>) => {
  const d = data as InboxAgentData | undefined;
  const fromId = d?.fromAgentId || 'agent';
  const agents = useAgentsFeed();
  const sender = agents.find((a) => a.id === fromId);
  const senderName = sender?.name ?? fromId;
  const label = d?.reply
    ? `${senderName} replied`
    : `Message from ${senderName}`;

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
        <AgentAvatarTile agent={sender} />
        <MailIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
};
