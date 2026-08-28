import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ChatMessage,
  compactMessages,
  type LLMClient,
  renderMemoryIndex,
} from '@agent-os/core';
import {
  loadThread,
  saveThread,
  type UIMessage,
  uiMessagesToChat,
} from './thread.js';

export const COMPACT_IDLE_MS = Number(
  process.env.AGENT_OS_COMPACT_IDLE_MS ?? 5 * 60 * 1000,
);
export const KEEP_RECENT_MESSAGES = 12;
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
  llm: LLMClient;
  model: string;
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
    try {
      const keep = thread.slice(-KEEP_RECENT_MESSAGES);
      const old = thread.slice(0, -KEEP_RECENT_MESSAGES);
      const oldChat: ChatMessage[] = uiMessagesToChat(old);
      const { bullets } = await compactMessages(deps.llm, deps.model, oldChat);
      if (bullets.length > 0) {
        const existing = await loadMemoryIndex(deps.homeDir);
        await saveMemoryIndex(
          deps.homeDir,
          renderMemoryIndex(existing, bullets),
        );
        const compacted: UIMessage[] = [
          {
            id: `compacted-${Date.now()}`,
            role: 'system',
            parts: [
              {
                type: 'text',
                text: `Earlier session compressed into memory index (${bullets.length} facts).`,
              },
            ],
          },
          ...keep,
        ];
        await saveThread(deps.homeDir, compacted);
      }
    } catch (err) {
      console.error('Compaction failed', err);
    } finally {
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

export { uiMessagesToChat };
