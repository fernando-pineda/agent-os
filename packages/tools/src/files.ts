import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

const fileRead: Tool = {
  spec: {
    name: 'file_read',
    description: 'Read a file within the agent home directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = resolvePath(args, ctx.homeDir);
    if (!filePath.ok) return filePath;
    try {
      const content = await readFile(filePath.value, 'utf-8');
      return { ok: true, output: content };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const fileWrite: Tool = {
  spec: {
    name: 'file_write',
    description: 'Write a file within the agent home directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const filePath = resolvePath(args, ctx.homeDir);
    if (!filePath.ok) return filePath;
    try {
      await mkdir(dirname(filePath.value), { recursive: true });
      await writeFile(filePath.value, String(args.content ?? ''), 'utf-8');
      return { ok: true, output: `wrote ${filePath.value}` };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

const fileList: Tool = {
  spec: {
    name: 'file_list',
    description: 'List files in a directory within the agent home directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const targetPath = resolvePath(args, ctx.homeDir, { defaultPath: '.' });
    if (!targetPath.ok) return targetPath;
    try {
      const entries = await readdir(targetPath.value, { withFileTypes: true });
      const lines = entries.map(
        (e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`,
      );
      return { ok: true, output: lines.join('\n') };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const fileTools = [fileRead, fileWrite, fileList];

interface PathResultOk {
  ok: true;
  value: string;
}

interface PathResultErr {
  ok: false;
  output: string;
}

type PathResult = PathResultOk | PathResultErr;

function resolvePath(
  args: Record<string, unknown>,
  homeDir: string,
  opts?: { defaultPath?: string },
): PathResult {
  const rawPath = typeof args.path === 'string' ? args.path : opts?.defaultPath;
  if (!rawPath) {
    return { ok: false, output: 'missing path' };
  }
  const resolved = resolve(join(homeDir, rawPath));
  if (!resolved.startsWith(homeDir)) {
    return { ok: false, output: `path outside agent home: ${rawPath}` };
  }
  return { ok: true, value: resolved };
}

function dirname(filePath: string): string {
  const lastSep = filePath.lastIndexOf('/');
  if (lastSep === -1) return '.';
  return filePath.slice(0, lastSep) || '/';
}
