'use client';

import type { ThreadMessageLike } from '@assistant-ui/react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useAgentUsage, useLivePreview } from '@/components/agent-context';
import { getMessages } from '@/lib/api';

export type RuntimeProviderProps = {
  children: ReactNode;
  agentId: string;
};

type ToolPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsText: string;
  result?: string;
  isError?: boolean;
};

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  toolParts?: ToolPart[];
};

function toThreadMessageLike(m: Msg): ThreadMessageLike {
  type Content = Exclude<ThreadMessageLike['content'], string>;
  type Part = Content extends ReadonlyArray<infer P> ? P : never;
  const content: Part[] = [];
  if (m.text) {
    content.push({ type: 'text', text: m.text });
  }
  for (const tp of m.toolParts ?? []) {
    content.push({
      type: 'tool-call',
      toolCallId: tp.toolCallId,
      toolName: tp.toolName,
      args: tp.args,
      argsText: tp.argsText,
      ...(tp.result !== undefined && { result: tp.result }),
      ...(tp.isError !== undefined && { isError: tp.isError }),
    } as Part);
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    content,
    // Tool calls run server-side with no approval gate; mark assistant
    // messages complete so assistant-ui never shows Allow/Deny.
    ...(m.role === 'assistant' && {
      status: { type: 'complete', reason: 'stop' } as const,
    }),
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

function extractToolParts(parts: unknown): ToolPart[] {
  if (!Array.isArray(parts)) return [];
  const out: ToolPart[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === 'object' &&
      (p as { type?: string }).type === 'tool-call'
    ) {
      const o = p as Record<string, unknown>;
      out.push({
        type: 'tool-call',
        toolCallId: String(o.toolCallId ?? ''),
        toolName: String(o.toolName ?? ''),
        args: (o.args as Record<string, unknown>) ?? {},
        argsText: String(o.argsText ?? JSON.stringify(o.args ?? {})),
        ...(o.result !== undefined && { result: String(o.result) }),
        ...(o.isError !== undefined && { isError: Boolean(o.isError) }),
      });
    }
  }
  return out;
}

export function RuntimeProvider({ children, agentId }: RuntimeProviderProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { setLivePreview, clearLivePreview } = useLivePreview();
  const { setUsage } = useAgentUsage();

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    getMessages(agentId)
      .then((ui) => {
        if (cancelled) return;
        const seenIds = new Set<string>();
        setMessages(
          ui.map((m, i) => {
            let id = m.id ?? `m-${i}`;
            while (seenIds.has(id)) id = `${id}-${i}`;
            seenIds.add(id);
            return {
              id,
              role: m.role,
              text:
                extractText(m.parts) ||
                (m as { content?: string }).content ||
                '',
              toolParts: extractToolParts(m.parts),
            };
          }),
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
        toolParts: [],
      };
      setMessages((prev) => [...prev, assistantMsg]);

      const toolMap = new Map<string, ToolPart>();
      const pushAssistant = (): void => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...assistantMsg, toolParts: Array.from(toolMap.values()) }
              : m,
          ),
        );
      };

      try {
        const res = await fetch(
          `http://localhost:8787/api/agents/${agentId}/chat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messages: nextMessages.map((m) => ({
                id: m.id,
                role: m.role,
                parts: [{ type: 'text', text: m.text }],
              })),
            }),
          },
        );
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
              assistantMsg.text += JSON.parse(line.slice(2)) as string;
              pushAssistant();
              setLivePreview(agentId, assistantMsg.text.slice(-120));
            } else if (line.startsWith('b:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                toolName: string;
              };
              toolMap.set(d.toolCallId, {
                type: 'tool-call',
                toolCallId: d.toolCallId,
                toolName: d.toolName,
                args: {},
                argsText: '',
              });
              pushAssistant();
              setLivePreview(agentId, `Running ${d.toolName}...`);
            } else if (line.startsWith('c:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                argsTextDelta: string;
                isFinal?: boolean;
              };
              const tp = toolMap.get(d.toolCallId);
              if (tp) {
                tp.argsText += d.argsTextDelta;
                try {
                  tp.args = JSON.parse(tp.argsText) as Record<string, unknown>;
                } catch {
                  // partial JSON while streaming
                }
                pushAssistant();
              }
            } else if (line.startsWith('a:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                result: unknown;
                isError?: boolean;
              };
              const tp = toolMap.get(d.toolCallId);
              if (tp) {
                tp.result =
                  typeof d.result === 'string'
                    ? d.result
                    : JSON.stringify(d.result);
                tp.isError = Boolean(d.isError);
                pushAssistant();
                const out = (tp.result ?? '').slice(0, 100);
                setLivePreview(agentId, out ? `→ ${out}` : 'Done');
              }
            } else if (line.startsWith('d:')) {
              const d = JSON.parse(line.slice(2)) as {
                usage?: { inputTokens?: number; outputTokens?: number };
              };
              if (d.usage) {
                setUsage(agentId, {
                  inputTokens: d.usage.inputTokens ?? 0,
                  outputTokens: d.usage.outputTokens ?? 0,
                });
              }
            }
          }
        }
      } catch (err) {
        assistantMsg.text += `\nError: ${err instanceof Error ? err.message : String(err)}`;
        pushAssistant();
      } finally {
        setIsRunning(false);
        clearLivePreview(agentId);
      }
    },
    [agentId, messages, setLivePreview, clearLivePreview, setUsage],
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
