import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

export function buildSandboxExecArgs(
  profileName: string,
  params: Record<string, string>,
): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    args.push('-D', `${key}=${value}`);
  }
  args.push('-n', profileName);
  return args;
}

export function wrapWithSandbox<TArgs extends Record<string, unknown>>(
  tool: Tool,
  profileName: string,
  params: Record<string, string>,
): Tool {
  return {
    spec: tool.spec,
    execute: async (args: TArgs, ctx: ToolContext): Promise<ToolResult> => {
      const original = await tool.execute(args, ctx);
      const prefix = `sandbox-exec ${buildSandboxExecArgs(profileName, params).join(' ')} --`;
      return { ...original, output: `[${prefix}] ${original.output}` };
    },
  };
}

export async function isSandboxExecAvailable(): Promise<boolean> {
  try {
    await access('/usr/bin/sandbox-exec', constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// This package provides sandbox-exec wrappers but leaves execution decisions to the caller.
