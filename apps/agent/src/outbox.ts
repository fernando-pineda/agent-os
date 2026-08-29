import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findPortFor } from './registry.js';

export interface OutboxEntry {
  toAgentId: string;
  message: string;
  inReplyTo: string;
  ts: number;
}

const RETRY_DELAYS: number[] = [2000, 5000, 15000, 30000];

let queue: Promise<void> = Promise.resolve();

export function outboxPath(homeDir: string): string {
  return join(homeDir, 'outbox.jsonl');
}

export function appendOutbox(
  homeDir: string,
  entry: OutboxEntry,
): Promise<void> {
  const next = queue.then(async () => {
    const path = outboxPath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    const line = JSON.stringify(entry);
    await appendFile(path, `${line}\n`, 'utf-8');
  });
  queue = next.catch(() => undefined);
  return next;
}

export function removeOutbox(
  homeDir: string,
  entry: OutboxEntry,
): Promise<void> {
  const next = queue.then(async () => {
    const path = outboxPath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const needle = JSON.stringify(entry);
    const lines = raw
      .split('\n')
      .filter((line) => line.trim() !== '' && line !== needle);
    await writeFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', {
      encoding: 'utf-8',
    });
  });
  queue = next.catch(() => undefined);
  return next;
}

export async function loadOutbox(homeDir: string): Promise<OutboxEntry[]> {
  const path = outboxPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const entries: OutboxEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'toAgentId' in parsed &&
        'message' in parsed &&
        'inReplyTo' in parsed &&
        'ts' in parsed
      ) {
        entries.push(parsed as OutboxEntry);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

export async function deliverWithRetry(
  fromAgentId: string,
  toAgentId: string,
  message: string,
  inReplyTo: string,
): Promise<boolean> {
  const port = await findPortFor(toAgentId);
  if (!port) {
    return false;
  }
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS[attempt - 1];
      if (delayMs) {
        await delay(delayMs);
      }
    }
    try {
      const res = await fetch(`http://localhost:${port}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fromAgentId,
          message,
          inReplyTo,
        }),
      });
      if (res.ok) {
        return true;
      }
      if (res.status === 409) {
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        continue;
      }
      return false;
    } catch {
      // retry on next attempt
    }
  }
  return false;
}

export async function drainOutbox(
  homeDir: string,
  fromAgentId: string,
): Promise<void> {
  const entries = await loadOutbox(homeDir);
  for (const entry of entries) {
    const ok = await deliverWithRetry(
      fromAgentId,
      entry.toAgentId,
      entry.message,
      entry.inReplyTo,
    );
    if (ok) {
      await removeOutbox(homeDir, entry);
    } else {
      console.error('Inbox outbox delivery failed after all retries', entry);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
