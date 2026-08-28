import type { ChatMessage, LLMClient } from './types.js';

const COMPACTION_PROMPT = `You are compressing a conversation transcript for long-term memory.
Rewrite the OLD messages into dense factual bullets for a persistent memory index.
Rules: one bullet per fact, decision, preference, or outcome. Keep names, paths, IDs, numbers.
Drop greetings and filler. Max 40 bullets. Output bullets only, each starting with "- ".`;

export interface CompactionResult {
  bullets: string[];
}

function toTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text =
        m.content.length > 2000 ? `${m.content.slice(0, 2000)}...` : m.content;
      return `[${m.role}] ${text}`;
    })
    .join('\n');
}

export async function compactMessages(
  llm: LLMClient,
  model: string,
  oldMessages: ChatMessage[],
): Promise<CompactionResult> {
  const transcript = toTranscript(oldMessages);
  let acc = '';
  const stream = llm.stream({
    model,
    messages: [
      { role: 'system', content: COMPACTION_PROMPT },
      { role: 'user', content: transcript },
    ],
    tools: [],
    temperature: 0,
  });
  for await (const event of stream) {
    if (event.type === 'text-delta') acc += event.delta;
  }
  const bullets = acc
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  return { bullets };
}

export function renderMemoryIndex(
  existing: string,
  sessionBullets: string[],
): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = `## ${stamp}\n${sessionBullets.join('\n')}\n`;
  return existing
    ? `${existing.trimEnd()}\n\n${block}`
    : `# Memory index\n\n${block}`;
}
