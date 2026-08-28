'use client';

import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { SendIcon } from 'lucide-react';

type MessageAgentArgs = {
  toAgentId?: string;
};

function getToAgentId(
  args: MessageAgentArgs,
  argsText: string,
): string | undefined {
  if (args.toAgentId) return args.toAgentId;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (parsed && typeof parsed === 'object' && 'toAgentId' in parsed) {
      return String((parsed as MessageAgentArgs).toAgentId);
    }
  } catch {
    // fall through
  }
  return undefined;
}

function isFailedResult(isError: boolean, result?: unknown): boolean {
  if (isError) return true;
  if (typeof result !== 'string' || !result) return false;
  const lower = result.toLowerCase();
  return (
    lower.startsWith('agent') ||
    lower.startsWith('busy') ||
    lower.startsWith('unreachable')
  );
}

export const MessageAgentTool = ({
  args,
  argsText,
  status,
  isError,
  result,
}: ToolCallMessagePartProps<MessageAgentArgs, unknown>) => {
  const toAgentId = getToAgentId(args, argsText ?? '');
  const target = toAgentId ?? 'agent';
  const running = status?.type === 'running';
  const failed = isFailedResult(Boolean(isError), result);

  let label: string;
  if (running) {
    label = `Sending a message to ${target}...`;
  } else if (failed) {
    label = `Message to ${target} failed`;
  } else {
    label = `I sent a message to ${target}`;
  }

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
        <SendIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
};

export const messageAgentToolkit = {
  message_agent: {
    render: MessageAgentTool,
  },
};
