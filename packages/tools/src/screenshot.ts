import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatImage, Tool, ToolContext, ToolResult } from '@agent-os/core';
import { type Browser, type Page, webkit } from 'playwright';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const GOTO_TIMEOUT_MS = 30_000;

export const screenshot: Tool = {
  spec: {
    name: 'screenshot',
    description: 'Take a screenshot of a web page using Playwright webkit',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        outputPath: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['url'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const url = typeof args.url === 'string' ? args.url : '';
    const outputPath =
      typeof args.outputPath === 'string'
        ? join(ctx.homeDir, args.outputPath)
        : join(ctx.homeDir, 'screenshot.png');
    const width = typeof args.width === 'number' ? args.width : DEFAULT_WIDTH;
    const height =
      typeof args.height === 'number' ? args.height : DEFAULT_HEIGHT;

    let browser: Browser | undefined;
    let page: Page | undefined;

    try {
      browser = await webkit.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height } });
      await page.goto(url, { timeout: GOTO_TIMEOUT_MS, waitUntil: 'load' });
      await page.screenshot({ path: outputPath, fullPage: false });
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
    } finally {
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  },
};
