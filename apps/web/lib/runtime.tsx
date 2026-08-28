'use client';

import type { ThreadMessageLike } from '@assistant-ui/react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { getMessages } from '@/lib/api';

export type RuntimeProviderProps = {
  children: ReactNode;
  agentId: string;
};

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
};

function toThreadMessageLike(m: Msg): ThreadMessageLike {
  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    content: [{ type: 'text', text: m.text }],
    createdAt: new Date(),
  };
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) =>
      p && typeof p === 'object' && 'text' in p
        ? String((p as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

export function RuntimeProvider({ children, agentId }: RuntimeProviderProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    getMessages(agentId)
      .then((ui) => {
        if (cancelled) return;
        setMessages(
          ui.map((m, i) => ({
            id: m.id ?? `m-${i}`,
            role: m.role,
            text:
              extractText(m.parts) || (m as { content?: string }).content || '',
          })),
        );
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const onNew = useCallback(
    async (message: {
      content: ReadonlyArray<{ type: string; text?: string }>;
    }) => {
      const text = message.content
        .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
        .join('');
      if (!text) return;

      const userMsg: Msg = {
        id: crypto.randomUUID(),
        role: 'user',
        text,
      };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setIsRunning(true);

      const assistantMsg: Msg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: '',
      };
      setMessages((prev) => [...prev, assistantMsg]);

      try {
        const res = await fetch(`/backend/api/agents/${agentId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: nextMessages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: [{ type: 'text', text: m.text }],
            })),
          }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`chat failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('0:')) {
              const delta = JSON.parse(line.slice(2)) as string;
              assistantMsg.text += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...assistantMsg } : m,
                ),
              );
            }
          }
        }
      } catch (err) {
        assistantMsg.text += `\nError: ${err instanceof Error ? err.message : String(err)}`;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...assistantMsg } : m)),
        );
      } finally {
        setIsRunning(false);
      }
    },
    [agentId, messages],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (m: Msg): ThreadMessageLike => toThreadMessageLike(m),
    isRunning,
    onNew,
  });

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        Loading conversation...
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
