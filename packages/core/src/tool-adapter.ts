import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Tool, ToolContext } from './types.js';

export function toolToPiDefinition(
  tool: Tool,
  contextFactory: (signal?: AbortSignal) => ToolContext,
): ToolDefinition {
  const parameters = Type.Unsafe<Record<string, never>>(tool.spec.parameters);

  return {
    name: tool.spec.name,
    label: tool.spec.name,
    description: tool.spec.description,
    parameters,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      if (
        typeof params !== 'object' ||
        params === null ||
        Array.isArray(params)
      ) {
        throw new TypeError(
          `Tool ${tool.spec.name} received non-object parameters`,
        );
      }
      const args = Object.fromEntries(Object.entries(params));
      const result = await tool.execute(args, contextFactory(signal));
      const content: (TextContent | ImageContent)[] = [
        { type: 'text', text: result.output },
        ...(result.images ?? []).map(
          (image): ImageContent => ({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          }),
        ),
      ];

      return {
        content,
        details: { ok: result.ok, isError: result.isError },
      };
    },
  };
}
