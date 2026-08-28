import OpenAI from 'openai';
import type { ChatMessage, ChatRequest, LLMClient, LLMEvent } from './types.js';

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class FireworksLLMClient implements LLMClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.fireworks.ai/inference/v1',
    });
  }

  async *stream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const messages = req.messages.map((m) => toOpenAIMessage(m));
    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: req.temperature ?? 0.1,
          stream: true,
        },
        { signal },
      );

      const toolCalls = new Map<number, AccumulatedToolCall>();
      let finishReason: string | undefined;
      let usage:
        | { promptTokens?: number; completionTokens?: number }
        | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { type: 'text-delta', delta: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            let accumulated = toolCalls.get(index);
            if (!accumulated) {
              if (!tc.id || !tc.function?.name) {
                continue;
              }
              accumulated = {
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments ?? '',
              };
              toolCalls.set(index, accumulated);
            } else if (tc.function?.arguments) {
              accumulated.arguments += tc.function.arguments;
            }
          }
        }

        const reason = chunk.choices[0]?.finish_reason;
        if (reason) {
          finishReason = reason;
        }

        // Fireworks sends usage in the final streaming chunk; the openai type omits it.
        const usageChunk = (
          chunk as {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          }
        ).usage;
        if (usageChunk) {
          usage = {
            ...(usageChunk.prompt_tokens !== undefined && {
              promptTokens: usageChunk.prompt_tokens,
            }),
            ...(usageChunk.completion_tokens !== undefined && {
              completionTokens: usageChunk.completion_tokens,
            }),
          };
        }
      }

      if (finishReason === 'tool_calls') {
        for (const [, call] of toolCalls) {
          const args = parseToolCallArguments(call.arguments);
          yield {
            type: 'tool-call',
            call: { id: call.id, name: call.name, args },
          };
        }
        yield usage ? { type: 'done', usage } : { type: 'done' };
      } else {
        yield usage ? { type: 'done', usage } : { type: 'done' };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: message };
    }
  }
}

function toOpenAIMessage(
  m: ChatMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === 'system') {
    return { role: 'system', content: m.content };
  }
  if (m.role === 'user') {
    return { role: 'user', content: m.content };
  }
  if (m.role === 'assistant') {
    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    return { role: 'assistant', content: m.content };
  }
  return {
    role: 'tool',
    content: m.content,
    tool_call_id: m.toolCallId ?? '',
  };
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
