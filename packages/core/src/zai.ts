import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  ChatRequest,
  LLMClient,
  LLMEvent,
  ToolSpec,
} from './types.js';

const MAX_TOKENS = 8192;
const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type MessageParam = Anthropic.Messages.MessageParam;
type MessageStreamEvent = Anthropic.Messages.MessageStreamEvent;
type Tool = Anthropic.Messages.Tool;

interface AccumulatedToolUse {
  id: string;
  name: string;
  json: string;
}

export class ZaiLLMClient implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, baseURL: ZAI_BASE_URL });
  }

  async *stream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const tools = req.tools.map((t) => toAnthropicTool(t));

    try {
      const stream = this.client.messages.stream(
        {
          model: req.model,
          max_tokens: MAX_TOKENS,
          ...(system !== undefined && { system }),
          messages,
          ...(tools.length > 0 && { tools }),
        },
        { signal },
      );

      const toolUses = new Map<number, AccumulatedToolUse>();
      let usage:
        | { promptTokens?: number; completionTokens?: number }
        | undefined;

      for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              toolUses.set(event.index, {
                id: block.id,
                name: block.name,
                json: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'text-delta', delta: delta.text };
            } else if (delta.type === 'input_json_delta') {
              const acc = toolUses.get(event.index);
              if (acc) {
                acc.json += delta.partial_json;
              }
            }
            break;
          }
          case 'message_stop': {
            const msg = await stream.finalMessage();
            const u = msg.usage;
            usage = {
              ...(u.input_tokens !== undefined && {
                promptTokens: u.input_tokens,
              }),
              ...(u.output_tokens !== undefined && {
                completionTokens: u.output_tokens,
              }),
            };
            break;
          }
          default:
            break;
        }
      }

      for (const [, call] of toolUses) {
        const args = parseToolUseInput(call.json);
        yield {
          type: 'tool-call',
          call: { id: call.id, name: call.name, args },
        };
      }

      yield usage ? { type: 'done', usage } : { type: 'done' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: message };
    }
  }
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  const systemParts: string[] = [];
  const out: MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }

    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: ContentBlockParam[] = [];
        if (m.content) {
          blocks.push({ type: 'text', text: m.content });
        }
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }

    // Tool results are user-role messages with tool_result content blocks.
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }

    // User message with images sends content as an array of text + image blocks.
    if (m.images && m.images.length > 0) {
      const blocks: ContentBlockParam[] = [];
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const img of m.images) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: img.data,
          },
        });
      }
      out.push({ role: 'user', content: blocks });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  return { system, messages: out };
}

function toAnthropicTool(tool: ToolSpec): Tool {
  return {
    name: tool.name,
    ...(tool.description && { description: tool.description }),
    input_schema: tool.parameters as Tool['input_schema'],
  };
}

function parseToolUseInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
