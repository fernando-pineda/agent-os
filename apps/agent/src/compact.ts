import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type PiSessionHandle, renderMemoryIndex } from '@agent-os/core';
import {
  type AgentUsage,
  chatMessagesToUi,
  loadThread,
  saveThread,
  saveUsage,
  type UIMessage,
} from './thread.js';

// Rough token estimate for a trimmed thread, used after compaction.
async function estimateThreadTokens(
  _homeDir: string,
  messages: UIMessage[],
): Promise<AgentUsage> {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p.type === 'text') chars += p.text.length;
      if (p.type === 'tool-call') chars += JSON.stringify(p.args).length;
      if (p.type === 'tool-result') chars += p.result.length;
    }
  }
  const tokens = Math.ceil(chars / 4);
  return { inputTokens: tokens, outputTokens: 0 };
}

export const COMPACT_IDLE_MS = Number(
  process.env.AGENT_OS_COMPACT_IDLE_MS ?? 5 * 60 * 1000,
);
export const MIN_MESSAGES_TO_COMPACT = Number(
  process.env.AGENT_OS_COMPACT_MIN ?? 20,
);

export function memoryIndexPath(homeDir: string): string {
  return join(homeDir, 'memory', 'index.md');
}

export async function loadMemoryIndex(homeDir: string): Promise<string> {
  try {
    return await readFile(memoryIndexPath(homeDir), 'utf-8');
  } catch {
    return '';
  }
}

async function saveMemoryIndex(
  homeDir: string,
  content: string,
): Promise<void> {
  const path = memoryIndexPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

export interface CompactionDeps {
  homeDir: string;
  sessionHandle: PiSessionHandle;
  setStatus: (s: 'compressing' | 'online') => void;
  isBusy: () => boolean;
}

export function scheduleCompaction(deps: CompactionDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runningCompaction = false;

  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), COMPACT_IDLE_MS);
  };

  const run = async (): Promise<void> => {
    if (runningCompaction || deps.isBusy()) {
      arm();
      return;
    }
    const thread = await loadThread(deps.homeDir);
    if (thread.length < MIN_MESSAGES_TO_COMPACT) {
      arm();
      return;
    }
    runningCompaction = true;
    deps.setStatus('compressing');
    let summary = '';
    const unsubscribe = deps.sessionHandle.subscribe((event) => {
      if (event.type === 'compaction_end' && event.result?.summary) {
        summary = event.result.summary;
      }
    });
    try {
      await deps.sessionHandle.compact();
      const compacted = chatMessagesToUi(deps.sessionHandle.getMessages());
      const bullets = summary
        .split('\n')
        .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter((line) => line.length > 0);
      const memoryBullets =
        bullets.length > 0
          ? bullets
          : [`Session compacted at ${new Date().toISOString()}.`];
      const existing = await loadMemoryIndex(deps.homeDir);
      await saveMemoryIndex(
        deps.homeDir,
        renderMemoryIndex(existing, memoryBullets),
      );
      await saveThread(deps.homeDir, compacted);
      const keptTokens = await estimateThreadTokens(deps.homeDir, compacted);
      await saveUsage(deps.homeDir, keptTokens);
    } catch (err) {
      console.error('Compaction failed', err);
    } finally {
      unsubscribe();
      runningCompaction = false;
      deps.setStatus('online');
      arm();
    }
  };

  arm();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
