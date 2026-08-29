import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChatImage, Tool, ToolContext, ToolResult } from '@agent-os/core';

const execFileAsync = promisify(execFile);

export const screenshot_desktop: Tool = {
  spec: {
    name: 'screenshot_desktop',
    description:
      'Capture the macOS desktop (screen) to a PNG and attach it to the chat.',
    parameters: {
      type: 'object',
      properties: {
        outputPath: { type: 'string' },
        display: { type: 'number' },
      },
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const outputPath =
      typeof args.outputPath === 'string'
        ? join(ctx.homeDir, args.outputPath)
        : join(ctx.homeDir, 'desktop_screenshot.png');
    const display = typeof args.display === 'number' ? args.display : undefined;

    const cmdArgs = ['-x'];
    if (display !== undefined) {
      cmdArgs.push('-D', String(display));
    }
    cmdArgs.push(outputPath);

    try {
      await execFileAsync('screencapture', cmdArgs);
      const images: ChatImage[] = [];
      try {
        const buf = await readFile(outputPath);
        images.push({ data: buf.toString('base64'), mimeType: 'image/png' });
      } catch {
        // Read-back failed; still return the path for the LLM.
      }
      return {
        ok: true,
        output: outputPath,
        ...(images.length > 0 && { images }),
      };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
