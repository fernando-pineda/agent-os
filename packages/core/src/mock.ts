import type { ChatRequest, LLMClient, LLMEvent } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockLLMClient implements LLMClient {
  async *stream(req: ChatRequest): AsyncGenerator<LLMEvent> {
    const lastTool = findLastToolResult(req.messages);
    if (lastTool !== undefined) {
      const summary = `Result: ok ${lastTool}`;
      for (const word of summary.split(' ')) {
        yield { type: 'text-delta', delta: `${word} ` };
        await sleep(5);
      }
      yield { type: 'done' };
      return;
    }

    const userMessage = findLastUserMessage(req.messages);
    if (userMessage?.startsWith('run ')) {
      const command = userMessage.slice(4);
      yield {
        type: 'tool-call',
        call: {
          id: 'mock-call-1',
          name: 'shell',
          args: { command },
        },
      };
      yield { type: 'done' };
      return;
    }

    const text = userMessage ? `Echo: ${userMessage}` : 'Echo: (no message)';
    for (const word of text.split(' ')) {
      yield { type: 'text-delta', delta: `${word} ` };
      await sleep(5);
    }
    yield { type: 'done' };
  }
}

function findLastUserMessage(
  messages: ChatRequest['messages'],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === 'user' && message.content) {
      return message.content;
    }
  }
  return undefined;
}

function findLastToolResult(
  messages: ChatRequest['messages'],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === 'tool' && message.content) {
      return message.content;
    }
  }
  return undefined;
}
