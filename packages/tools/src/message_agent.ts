import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

export const messageAgent: Tool = {
  spec: {
    name: 'message_agent',
    description: "Send a message to another agent's inbox and return its reply",
    parameters: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['toAgentId', 'message'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const toAgentId = typeof args.toAgentId === 'string' ? args.toAgentId : '';
    const message = typeof args.message === 'string' ? args.message : '';

    if (!ctx.sendAgentMessage) {
      return { ok: false, output: 'agent messaging unavailable' };
    }

    try {
      const reply = await ctx.sendAgentMessage(toAgentId, message);
      return { ok: true, output: reply };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
