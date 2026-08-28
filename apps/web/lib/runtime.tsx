'use client';

import type { ThreadMessageLike } from '@assistant-ui/react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  useAgentsFeed,
  useAgentUsage,
  useLivePreview,
} from '@/components/agent-context';
import { getMessages, getUsage } from '@/lib/api';

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
  // message_agent calls render as a standalone centered chip message.
  messageAgent?: { toAgentId: string; state: 'sending' | 'sent' | 'failed' };
  // Inbound agent messages (received via /inbox) render as their own chip.
  inboxAgent?: { fromAgentId: string; reply: boolean };
};

function toThreadMessageLike(m: Msg): ThreadMessageLike {
  if (m.messageAgent || m.inboxAgent) {
    return {
      id: m.id,
      role: 'assistant',
      content: [
        {
          type: 'data',
          name: m.messageAgent ? 'message-agent' : 'inbox-agent',
          data: m.messageAgent ?? m.inboxAgent,
        } as never,
      ],
      status: { type: 'complete', reason: 'stop' } as const,
      createdAt: new Date(),
    };
  }

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
      const toolName = String(o.toolName ?? '');
      // message_agent renders as a chip message, not a tool part.
      if (toolName === 'message_agent') continue;
      out.push({
        type: 'tool-call',
        toolCallId: String(o.toolCallId ?? ''),
        toolName,
        args: (o.args as Record<string, unknown>) ?? {},
        argsText: String(o.argsText ?? JSON.stringify(o.args ?? {})),
        ...(o.result !== undefined && { result: String(o.result) }),
        ...(o.isError !== undefined && { isError: Boolean(o.isError) }),
      });
    }
  }
  return out;
}

// Rebuild chip messages from persisted message_agent tool-call parts.
function extractMessageAgentChips(
  parts: unknown,
): NonNullable<Msg['messageAgent']>[] {
  if (!Array.isArray(parts)) return [];
  const chips: NonNullable<Msg['messageAgent']>[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === 'object' &&
      (p as { type?: string }).type === 'tool-call' &&
      (p as { toolName?: string }).toolName === 'message_agent'
    ) {
      const o = p as Record<string, unknown>;
      const args = (o.args as Record<string, unknown>) ?? {};
      const toAgentId =
        typeof args.toAgentId === 'string' ? args.toAgentId : '';
      const result = typeof o.result === 'string' ? o.result : '';
      const lower = result.toLowerCase();
      const failed =
        Boolean(o.isError) ||
        lower.startsWith('agent') ||
        lower.startsWith('busy') ||
        lower.startsWith('unreachable');
      chips.push({ toAgentId, state: failed ? 'failed' : 'sent' });
    }
  }
  return chips;
}

const INBOX_RE = /^\[agent-os:inbox from=([^\s\]]+)( reply)?\]/;

// Inbound agent messages get a chip before the (hidden) original text message.
function extractInboxChip(m: {
  role: string;
  parts?: unknown;
  content?: unknown;
}): NonNullable<Msg['inboxAgent']> | undefined {
  if (m.role !== 'user') return undefined;
  const text =
    extractText(m.parts) || (m as { content?: string }).content || '';
  const match = INBOX_RE.exec(typeof text === 'string' ? text : '');
  if (!match?.[1]) return undefined;
  return { fromAgentId: match[1], reply: Boolean(match[2]) };
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
    getUsage(agentId)
      .then((u) => {
        if (!cancelled) setUsage(agentId, u);
      })
      .catch(() => {});
    getMessages(agentId)
      .then((ui) => {
        if (cancelled) return;
        const seenIds = new Set<string>();
        setMessages(
          ui.flatMap((m, i) => {
            let id = m.id ?? `m-${i}`;
            while (seenIds.has(id)) id = `${id}-${i}`;
            seenIds.add(id);
            const out: Msg[] = [];
            const inboxChip = extractInboxChip(m);
            if (inboxChip) {
              // Chip replaces the raw text message; the assistant's reaction follows.
              out.push({
                id: `${id}-inbox`,
                role: 'assistant',
                text: '',
                inboxAgent: inboxChip,
              });
              return out;
            }
            const chips = extractMessageAgentChips(m.parts);
            // One chip message per persisted message_agent call.
            chips.forEach((chip, j) => {
              out.push({
                id: `${id}-chip-${j}`,
                role: 'assistant',
                text: '',
                messageAgent: chip,
              });
            });
            const text =
              extractText(m.parts) || (m as { content?: string }).content || '';
            const toolParts = extractToolParts(m.parts);
            if (text || toolParts.length > 0 || chips.length === 0) {
              out.push({ id, role: m.role, text, toolParts });
            }
            return out;
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
  }, [agentId, setUsage]);

  // When the SSE feed reports this agent working while the chat is idle,
  // an inbox message arrived. Re-fetch the thread and surface it as a chip.
  const agents = useAgentsFeed();
  const agentStatus = agents.find((a) => a.id === agentId)?.status;
  const knownIdsRef = useRef<Set<string> | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    if (!loaded) return;
    const known = knownIdsRef.current;
    if (known === null) {
      knownIdsRef.current = new Set(messages.map((m) => m.id));
      return;
    }
    for (const m of messages) known.add(m.id);
    if (isRunning || fetchingRef.current) return;
    if (agentStatus !== 'busy' && agentStatus !== 'starting') return;
    fetchingRef.current = true;
    getMessages(agentId)
      .then((ui) => {
        const additions: Msg[] = [];
        const seen = new Set(known);
        ui.forEach((m, i) => {
          let id = m.id ?? `m-${i}`;
          while (seen.has(id)) id = `${id}-${i}`;
          seen.add(id);
          const inboxChip = extractInboxChip(m);
          if (inboxChip) {
            additions.push({
              id: `${id}-inbox`,
              role: 'assistant',
              text: '',
              inboxAgent: inboxChip,
            });
          } else {
            const text =
              extractText(m.parts) || (m as { content?: string }).content || '';
            const toolParts = extractToolParts(m.parts);
            const chips = extractMessageAgentChips(m.parts);
            chips.forEach((chip, j) => {
              additions.push({
                id: `${id}-chip-${j}`,
                role: 'assistant',
                text: '',
                messageAgent: chip,
              });
            });
            if (text || toolParts.length > 0 || chips.length === 0) {
              additions.push({ id, role: m.role, text, toolParts });
            }
          }
        });
        for (const a of additions) known.add(a.id);
        if (additions.length > 0) {
          setMessages((prev) => [...prev, ...additions]);
        }
      })
      .catch(() => {})
      .finally(() => {
        fetchingRef.current = false;
      });
  }, [agentStatus, agentId, isRunning, loaded, messages]);

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

      // Each text run and each tool call is its own message, in order.
      let current: Msg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: '',
        toolParts: [],
      };
      setMessages((prev) => [...prev, current]);

      const pushCurrent = (): void => {
        const id = current.id;
        const snapshot = { ...current };
        setMessages((prev) => prev.map((m) => (m.id === id ? snapshot : m)));
      };

      const startNew = (toolParts?: ToolPart[]): Msg => {
        current = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '',
          ...(toolParts ? { toolParts } : {}),
        };
        const c = current;
        setMessages((prev) => [...prev, c]);
        return c;
      };

      const toolMap = new Map<string, ToolPart>();
      const chipMap = new Map<string, string>(); // toolCallId -> accumulated argsText
      const updateChip = (
        toolCallId: string,
        update: Partial<NonNullable<Msg['messageAgent']>>,
      ): void => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === toolCallId && m.messageAgent
              ? { ...m, messageAgent: { ...m.messageAgent, ...update } }
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
              // Text after a tool call joins that same message, not a new one.
              current.text += JSON.parse(line.slice(2)) as string;
              pushCurrent();
              setLivePreview(agentId, current.text.slice(-120));
            } else if (line.startsWith('b:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                toolName: string;
              };
              if (d.toolName === 'message_agent') {
                // Flush pending text, then emit a standalone chip message.
                if (current.text || (current.toolParts?.length ?? 0) > 0) {
                  startNew();
                }
                const chip: Msg = {
                  id: d.toolCallId,
                  role: 'assistant',
                  text: '',
                  messageAgent: { toAgentId: '', state: 'sending' },
                };
                chipMap.set(d.toolCallId, '');
                setMessages((prev) => [...prev, chip]);
              } else {
                const tp: ToolPart = {
                  type: 'tool-call',
                  toolCallId: d.toolCallId,
                  toolName: d.toolName,
                  args: {},
                  argsText: '',
                };
                toolMap.set(d.toolCallId, tp);
                startNew([tp]);
              }
              setLivePreview(agentId, `Running ${d.toolName}...`);
            } else if (line.startsWith('c:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                argsTextDelta: string;
                isFinal?: boolean;
              };
              const chipArgs = chipMap.get(d.toolCallId);
              if (chipArgs !== undefined) {
                // Accumulate argsText and surface toAgentId as soon as it parses.
                const acc = chipArgs + d.argsTextDelta;
                chipMap.set(d.toolCallId, acc);
                try {
                  const parsed = JSON.parse(acc) as { toAgentId?: unknown };
                  if (typeof parsed.toAgentId === 'string') {
                    updateChip(d.toolCallId, { toAgentId: parsed.toAgentId });
                  }
                } catch {
                  // partial JSON while streaming
                }
              } else {
                const tp = toolMap.get(d.toolCallId);
                if (tp) {
                  tp.argsText += d.argsTextDelta;
                  try {
                    tp.args = JSON.parse(tp.argsText) as Record<
                      string,
                      unknown
                    >;
                  } catch {
                    // partial JSON while streaming
                  }
                  pushCurrent();
                }
              }
            } else if (line.startsWith('a:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                result: unknown;
                isError?: boolean;
              };
              if (chipMap.has(d.toolCallId)) {
                const resultText =
                  typeof d.result === 'string'
                    ? d.result
                    : JSON.stringify(d.result ?? '');
                const lower = resultText.toLowerCase();
                const failed =
                  Boolean(d.isError) ||
                  lower.startsWith('agent') ||
                  lower.startsWith('busy') ||
                  lower.startsWith('unreachable');
                updateChip(d.toolCallId, {
                  state: failed ? 'failed' : 'sent',
                });
              } else {
                const tp = toolMap.get(d.toolCallId);
                if (tp) {
                  tp.result =
                    typeof d.result === 'string'
                      ? d.result
                      : JSON.stringify(d.result);
                  tp.isError = Boolean(d.isError);
                  pushCurrent();
                  const out = (tp.result ?? '').slice(0, 100);
                  setLivePreview(agentId, out ? `→ ${out}` : 'Done');
                }
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
        if ((current.toolParts?.length ?? 0) > 0) {
          startNew();
        }
        current.text += `\nError: ${err instanceof Error ? err.message : String(err)}`;
        pushCurrent();
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
