'use client';

import type { ThreadMessageLike } from '@assistant-ui/react';
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAgentUsage, useLivePreview } from '@/components/agent-context';
import {
  getMessages,
  getUsage,
  SUPERVISOR_BASE,
  subscribeAgentMessages,
} from '@/lib/api';

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

type MsgImage = { data: string; mimeType: string };

function uid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  images?: MsgImage[];
  toolParts?: ToolPart[];
  messageAgent?: { toAgentId: string; state: 'sending' | 'sent' | 'failed' };
  inboxAgent?: { fromAgentId: string; reply: boolean };
  repliedToAgent?: { toAgentId: string };
};

function hasRenderableContent(m: Msg): boolean {
  return Boolean(
    m.text ||
      m.images?.length ||
      m.messageAgent ||
      m.inboxAgent ||
      m.repliedToAgent,
  );
}

function toThreadMessageLike(m: Msg): ThreadMessageLike {
  if (m.messageAgent || m.inboxAgent || m.repliedToAgent) {
    return {
      id: m.id,
      role: 'assistant',
      content: [
        {
          type: 'data',
          name: m.messageAgent
            ? 'message-agent'
            : m.inboxAgent
              ? 'inbox-agent'
              : 'replied-to-agent',
          data: m.messageAgent ?? m.inboxAgent ?? m.repliedToAgent,
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
  if (m.images) {
    for (const img of m.images) {
      content.push({
        type: 'image',
        image: `data:${img.mimeType};base64,${img.data}`,
      } as never);
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    content,
    ...(m.role === 'assistant' && {
      status: { type: 'complete', reason: 'stop' } as const,
    }),
    createdAt: new Date(),
  };
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  let prevWasTool = false;
  for (const p of parts) {
    const isTool =
      p &&
      typeof p === 'object' &&
      (p as { type?: string }).type === 'tool-call';
    if (isTool) {
      prevWasTool = true;
      continue;
    }
    const text =
      p && typeof p === 'object' && 'text' in p
        ? String((p as { text?: unknown }).text ?? '')
        : '';
    if (text) {
      out.push(prevWasTool ? `\n\n${text}` : text);
      prevWasTool = false;
    }
  }
  return out.join('');
}

function extractImageParts(parts: unknown): MsgImage[] {
  if (!Array.isArray(parts)) return [];
  const out: MsgImage[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === 'object' &&
      (p as { type?: string }).type === 'image'
    ) {
      const image = String((p as { image?: unknown }).image ?? '');
      const match = /^data:([^;]+);base64,(.+)$/.exec(image);
      if (match?.[1] && match[2]) {
        out.push({ mimeType: match[1], data: match[2] });
      }
    }
  }
  return out;
}

function messageAgentChipId(
  messageId: string,
  toolCallId: string,
  partIndex: number,
): string {
  return toolCallId ? `chip-${toolCallId}` : `${messageId}-chip-${partIndex}`;
}

function extractMessageAgentChip(
  part: unknown,
  messageId: string,
  partIndex: number,
): { id: string; messageAgent: NonNullable<Msg['messageAgent']> } | undefined {
  if (
    !part ||
    typeof part !== 'object' ||
    (part as { type?: string }).type !== 'tool-call' ||
    (part as { toolName?: string }).toolName !== 'message_agent'
  ) {
    return undefined;
  }
  const o = part as Record<string, unknown>;
  const args = (o.args as Record<string, unknown>) ?? {};
  const toAgentId = typeof args.toAgentId === 'string' ? args.toAgentId : '';
  const toolCallId = typeof o.toolCallId === 'string' ? o.toolCallId : '';
  const result = typeof o.result === 'string' ? o.result : '';
  const lower = result.toLowerCase();
  const failed =
    Boolean(o.isError) ||
    lower.startsWith('agent') ||
    lower.startsWith('busy') ||
    lower.startsWith('unreachable');
  return {
    id: messageAgentChipId(messageId, toolCallId, partIndex),
    messageAgent: {
      toAgentId,
      state: failed ? 'failed' : 'sent',
    },
  };
}

function getPartId(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const o = part as Record<string, unknown>;
  if (typeof o.id === 'string' && o.id) return o.id;
  if (typeof o.toolCallId === 'string' && o.toolCallId) {
    return o.toolCallId;
  }
  return undefined;
}

function buildOrderedMsgs(
  id: string,
  role: Msg['role'],
  parts: unknown,
): Msg[] {
  const out: Msg[] = [];
  if (!Array.isArray(parts)) return out;
  let text = '';
  let prevWasTool = false;
  let textPart: unknown;
  let textPartIndex = 0;
  const usedIds = new Set<string>();
  const partMessageId = (
    kind: string,
    part: unknown,
    index: number,
  ): string => {
    const partId = getPartId(part) ?? String(index);
    const base = `${id}-${kind}-${partId}`;
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix++;
    }
    usedIds.add(candidate);
    return candidate;
  };
  const flushText = (): void => {
    if (text) {
      out.push({
        id: partMessageId('text', textPart, textPartIndex),
        role,
        text,
      });
      text = '';
      textPart = undefined;
    }
  };
  for (const [partIndex, p] of parts.entries()) {
    const isTool =
      p &&
      typeof p === 'object' &&
      (p as { type?: string }).type === 'tool-call';
    const isImage =
      p && typeof p === 'object' && (p as { type?: string }).type === 'image';
    if (isTool) {
      flushText();
      const chip = extractMessageAgentChip(p, id, partIndex);
      if (chip) {
        out.push({
          id: chip.id,
          role: 'assistant',
          text: '',
          messageAgent: chip.messageAgent,
        });
        prevWasTool = false;
      } else {
        prevWasTool = true;
      }
      continue;
    }
    if (isImage) {
      flushText();
      const img = extractImageParts([p]);
      if (img.length > 0) {
        const last = out[out.length - 1];
        if (
          last &&
          last.role === role &&
          !last.messageAgent &&
          !last.inboxAgent
        ) {
          last.images = [...(last.images ?? []), ...img];
        } else {
          out.push({
            id: partMessageId('image', p, partIndex),
            role,
            text: '',
            images: img,
          });
        }
      }
      prevWasTool = false;
      continue;
    }
    const t =
      p && typeof p === 'object' && 'text' in p
        ? String((p as { text?: unknown }).text ?? '')
        : '';
    if (t) {
      if (!text) {
        textPart = p;
        textPartIndex = partIndex;
      }
      text += prevWasTool ? `\n\n${t}` : t;
      prevWasTool = false;
    }
  }
  flushText();
  return out;
}

const INBOX_RE = /^\[agent-os:inbox from=([^\s\]]+)( reply)?\]/;

function extractInboxChip(m: {
  role: string;
  parts?: unknown;
  content?: unknown;
  metadata?: unknown;
}): NonNullable<Msg['inboxAgent']> | undefined {
  if (m.role !== 'user') return undefined;
  const meta = m.metadata as
    | { agentOsInbox?: boolean; fromAgentId?: string; reply?: boolean }
    | undefined;
  if (meta?.agentOsInbox && typeof meta.fromAgentId === 'string') {
    return { fromAgentId: meta.fromAgentId, reply: Boolean(meta.reply) };
  }
  const text =
    extractText(m.parts) || (m as { content?: string }).content || '';
  const match = INBOX_RE.exec(typeof text === 'string' ? text : '');
  if (!match?.[1]) return undefined;
  return { fromAgentId: match[1], reply: Boolean(match[2]) };
}

function extractRepliedToChip(m: {
  role: string;
  metadata?: unknown;
}): NonNullable<Msg['repliedToAgent']> | undefined {
  if (m.role !== 'assistant') return undefined;
  const meta = m.metadata as { replyToAgentId?: unknown } | undefined;
  const id = meta?.replyToAgentId;
  if (typeof id !== 'string' || !id) return undefined;
  return { toAgentId: id };
}

function parseThreadMessages(ui: unknown[]): Msg[] {
  const seenIds = new Set<string>();
  return (ui as Record<string, unknown>[]).flatMap((m, i) => {
    const base = (m.id as string | undefined) ?? `m-${i}`;
    let id = base;
    if (seenIds.has(base)) {
      let n = 1;
      while (seenIds.has(`${base}~${n}`)) n++;
      id = `${base}~${n}`;
    }
    seenIds.add(id);
    const role = m.role as Msg['role'];
    const parts = m.parts as unknown;
    const out: Msg[] = [];
    const inboxChip = extractInboxChip(m as never);
    if (inboxChip) {
      out.push({
        id: `inbox-${id}`,
        role: 'assistant',
        text: '',
        inboxAgent: inboxChip,
      });
      return out;
    }
    const repliedToChip = extractRepliedToChip(m as never);
    if (repliedToChip) {
      out.push({
        id: `${id}-replied`,
        role: 'assistant',
        text: '',
        repliedToAgent: repliedToChip,
      });
    }
    const ordered = buildOrderedMsgs(id, role, parts);
    if (ordered.length > 0) {
      out.push(...ordered);
    } else {
      const text =
        extractText(parts) || (m as { content?: string }).content || '';
      const images = extractImageParts(parts);
      if (
        text ||
        images.length > 0 ||
        (role !== 'assistant' && role !== 'tool')
      ) {
        out.push({
          id,
          role,
          text,
          ...(images.length > 0 && { images }),
          toolParts: [],
        });
      }
    }
    return out;
  });
}

export function RuntimeProvider({ children, agentId }: RuntimeProviderProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const isRunningRef = useRef(false);
  const localRunRef = useRef(0);
  const snapshotVersionRef = useRef(0);
  const activeAgentRef = useRef(agentId);
  const [loaded, setLoaded] = useState(false);
  const { setLivePreview, clearLivePreview } = useLivePreview();
  const { setUsage } = useAgentUsage();

  useEffect(() => {
    let cancelled = false;
    if (activeAgentRef.current !== agentId) {
      localRunRef.current++;
      isRunningRef.current = false;
      setIsRunning(false);
      abortRef.current?.abort();
      abortRef.current = null;
      activeAgentRef.current = agentId;
    }
    setLoaded(false);
    getUsage(agentId)
      .then((u) => {
        if (!cancelled) setUsage(agentId, u);
      })
      .catch((err) => {
        console.error('usage load failed', err);
      });
    getMessages(agentId)
      .then((ui) => {
        if (cancelled) return;
        setMessages(parseThreadMessages(ui as unknown[]));
        setLoaded(true);
      })
      .catch((err) => {
        console.error('message load failed', err);
        if (!cancelled) {
          setMessages([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, setUsage]);

  isRunningRef.current = isRunning;
  useEffect(() => {
    if (!loaded) return;
    const unsubscribe = subscribeAgentMessages(
      agentId,
      (raw) => {
        snapshotVersionRef.current++;
        if (isRunningRef.current) return;
        setMessages(parseThreadMessages(raw));
      },
      (err) => console.error(err),
    );
    return unsubscribe;
  }, [agentId, loaded]);

  const onNew = useCallback(
    async (message: {
      content: ReadonlyArray<{ type: string; text?: string }>;
      attachments?: ReadonlyArray<{
        type: string;
        content?: ReadonlyArray<{ type: string; image?: string }>;
      }>;
    }) => {
      const text = message.content
        .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
        .join('');
      if (!text) return;

      const localRunId = ++localRunRef.current;

      const images: MsgImage[] = [];
      for (const att of message.attachments ?? []) {
        if (att.type !== 'image') continue;
        for (const part of att.content ?? []) {
          if (part.type !== 'image') continue;
          const dataUrl = part.image ?? '';
          const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
          if (match?.[1] && match[2]) {
            images.push({ mimeType: match[1], data: match[2] });
          }
        }
      }

      const userMsg: Msg = {
        id: uid(),
        role: 'user',
        text,
        ...(images.length > 0 && { images }),
      };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      isRunningRef.current = true;
      setIsRunning(true);

      let current: Msg = {
        id: uid(),
        role: 'assistant',
        text: '',
        toolParts: [],
      };

      const pushCurrent = (): void => {
        const id = current.id;
        const snapshot = { ...current };
        if (!hasRenderableContent(snapshot)) return;
        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === id);
          if (index < 0) return [...prev, snapshot];
          return prev.map((m) => (m.id === id ? snapshot : m));
        });
      };

      const startNew = (): Msg => {
        current = {
          id: uid(),
          role: 'assistant',
          text: '',
        };
        return current;
      };

      const toolMap = new Map<string, ToolPart>();
      const chipMap = new Map<string, { id: string; argsText: string }>();
      let chipIndex = 0;
      const updateChip = (
        toolCallId: string,
        update: Partial<NonNullable<Msg['messageAgent']>>,
      ): void => {
        const chip = chipMap.get(toolCallId);
        if (!chip) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === chip.id && m.messageAgent
              ? { ...m, messageAgent: { ...m.messageAgent, ...update } }
              : m,
          ),
        );
      };

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `${SUPERVISOR_BASE}/api/agents/${agentId}/chat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              messages: nextMessages.map((m) => {
                const parts: Array<
                  | { type: 'text'; text: string }
                  | { type: 'image'; image: string; mimeType: string }
                > = [{ type: 'text', text: m.text }];
                if (m.images) {
                  for (const img of m.images) {
                    parts.push({
                      type: 'image',
                      image: `data:${img.mimeType};base64,${img.data}`,
                      mimeType: img.mimeType,
                    });
                  }
                }
                return { id: m.id, role: m.role, parts };
              }),
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
              current.text += JSON.parse(line.slice(2)) as string;
              pushCurrent();
              setLivePreview(agentId, current.text.slice(-120));
            } else if (line.startsWith('b:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                toolName: string;
              };
              if (d.toolName === 'message_agent') {
                pushCurrent();
                const previousCurrent = current;
                startNew();
                const chip: Msg = {
                  id: messageAgentChipId(
                    previousCurrent.id,
                    d.toolCallId,
                    chipIndex,
                  ),
                  role: 'assistant',
                  text: '',
                  messageAgent: { toAgentId: '', state: 'sending' },
                };
                chipIndex++;
                chipMap.set(d.toolCallId, { id: chip.id, argsText: '' });
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
              }
              setLivePreview(agentId, `Running ${d.toolName}...`);
            } else if (line.startsWith('c:')) {
              const d = JSON.parse(line.slice(2)) as {
                toolCallId: string;
                argsTextDelta: string;
                isFinal?: boolean;
              };
              const chip = chipMap.get(d.toolCallId);
              if (chip) {
                const acc = chip.argsText + d.argsTextDelta;
                chip.argsText = acc;
                try {
                  const parsed = JSON.parse(acc) as { toAgentId?: unknown };
                  if (typeof parsed.toAgentId === 'string') {
                    updateChip(d.toolCallId, { toAgentId: parsed.toAgentId });
                  }
                } catch (err) {
                  if (!(err instanceof SyntaxError)) throw err;
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
                  } catch (err) {
                    if (!(err instanceof SyntaxError)) throw err;
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
            } else if (line.startsWith('k:')) {
              const d = JSON.parse(line.slice(2)) as {
                data: string;
                mimeType: string;
              };
              const img: MsgImage = { data: d.data, mimeType: d.mimeType };
              if (current.text || (current.toolParts?.length ?? 0) > 0) {
                current.images = [...(current.images ?? []), img];
                pushCurrent();
              } else {
                current.images = [img];
                pushCurrent();
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (!current.text) current.text = 'Stopped.';
          pushCurrent();
          clearLivePreview(agentId);
        } else {
          if ((current.toolParts?.length ?? 0) > 0) {
            startNew();
          }
          if (!current.text) {
            current.text = `Error: ${err instanceof Error ? err.message : String(err)}`;
          } else {
            current.text += `\n\nError: ${err instanceof Error ? err.message : String(err)}`;
          }
          pushCurrent();
          clearLivePreview(agentId);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (localRunRef.current === localRunId) {
          isRunningRef.current = false;
          setIsRunning(false);
          const snapshotVersion = snapshotVersionRef.current;
          void getMessages(agentId)
            .then((ui) => {
              if (
                localRunRef.current !== localRunId ||
                snapshotVersionRef.current !== snapshotVersion ||
                !ui.some((m) => m.id === userMsg.id)
              ) {
                return;
              }
              setMessages(parseThreadMessages(ui as unknown[]));
            })
            .catch((err) => {
              console.error('message reconciliation failed', err);
            });
        }
        clearLivePreview(agentId);
      }
    },
    [agentId, messages, setLivePreview, clearLivePreview, setUsage],
  );

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await fetch(`${SUPERVISOR_BASE}/api/agents/${agentId}/abort`, {
        method: 'POST',
      });
    } catch (err) {
      console.error('abort failed', err);
    }
  }, [agentId]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (m: Msg): ThreadMessageLike => toThreadMessageLike(m),
    isRunning,
    onNew,
    onCancel,
    adapters: {
      attachments: new SimpleImageAttachmentAdapter(),
    },
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
