import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage, ToolCall } from '@agent-os/core';

export type UIMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface UIMessageTextPart {
  type: 'text';
  text: string;
}

export interface UIMessageToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface UIMessageToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  result: string;
  isError?: boolean;
}

export type UIMessagePart =
  | UIMessageTextPart
  | UIMessageToolCallPart
  | UIMessageToolResultPart;

export interface UIMessage {
  id: string;
  role: UIMessageRole;
  content?: string | undefined;
  parts?: UIMessagePart[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export function threadPath(homeDir: string): string {
  return join(homeDir, 'thread.json');
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export function usagePath(homeDir: string): string {
  return join(homeDir, 'usage.json');
}

export async function loadUsage(homeDir: string): Promise<AgentUsage> {
  try {
    const raw = await readFile(usagePath(homeDir), 'utf-8');
    return JSON.parse(raw) as AgentUsage;
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

export async function saveUsage(
  homeDir: string,
  usage: AgentUsage,
): Promise<void> {
  const tmp = `${usagePath(homeDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(usage), 'utf-8');
  await rename(tmp, usagePath(homeDir));
}

export async function loadThread(homeDir: string): Promise<UIMessage[]> {
  try {
    const raw = await readFile(threadPath(homeDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as UIMessage[];
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    console.warn('Failed to load thread', err);
  }
  return [];
}

export async function saveThread(
  homeDir: string,
  messages: UIMessage[],
): Promise<void> {
  const path = threadPath(homeDir);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(messages, null, 2), 'utf-8');
  await rename(tempPath, path);
}

export function chatMessagesToUi(messages: ChatMessage[]): UIMessage[] {
  return messages.map((m, index) => {
    const parts: UIMessagePart[] = [];
    if (m.content) {
      parts.push({ type: 'text', text: m.content });
    }
    if (m.toolCalls) {
      for (const call of m.toolCalls) {
        parts.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          args: call.args,
        });
      }
    }
    const msg: UIMessage = {
      id: `msg-${index}`,
      role: m.role,
      content: m.content,
    };
    if (parts.length > 0) {
      msg.parts = parts;
    }
    return msg;
  });
}

export function uiMessagesToChat(messages: UIMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const m of messages) {
    const content = m.content ?? textParts(m).join('\n');
    if (m.role === 'tool') {
      const toolCallId = m.metadata?.toolCallId as string | undefined;
      const toolMsg: ChatMessage = { role: 'tool', content };
      if (toolCallId !== undefined) {
        toolMsg.toolCallId = toolCallId;
      }
      result.push(toolMsg);
      continue;
    }
    if (m.role === 'assistant' && m.parts) {
      const toolCalls: ToolCall[] = [];
      for (const part of m.parts) {
        if (part.type === 'tool-call') {
          toolCalls.push({
            id: part.toolCallId,
            name: part.toolName,
            args: part.args,
          });
        }
      }
      const assistantMsg: ChatMessage = { role: 'assistant', content };
      if (toolCalls.length > 0) {
        assistantMsg.toolCalls = toolCalls;
      }
      result.push(assistantMsg);
      continue;
    }
    result.push({ role: m.role, content });
  }
  return result;
}

function textParts(m: UIMessage): string[] {
  const parts: string[] = [];
  for (const part of m.parts ?? []) {
    if (part.type === 'text') {
      parts.push(part.text);
    }
  }
  return parts;
}
