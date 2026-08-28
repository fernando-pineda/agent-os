import { type ChildProcess, execFile } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const shell: Tool = {
  spec: {
    name: 'shell',
    description: 'Run a zsh shell command in the agent home directory',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const command = typeof args.command === 'string' ? args.command : '';
    const timeoutMs =
      typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const _stdout = '';
      const _stderr = '';
      let child: ChildProcess | undefined;
      let timeoutId: NodeJS.Timeout | undefined;
      let settled = false;

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      const onSignalAbort = () => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
        settle({ ok: false, output: 'aborted' });
      };

      ctx.signal?.addEventListener('abort', onSignalAbort, { once: true });

      child = execFile(
        'zsh',
        ['-lc', command],
        { cwd: ctx.homeDir, env: { ...process.env, ...ctx.env } },
        (error, rawStdout, rawStderr) => {
          const out = truncate(rawStdout, MAX_OUTPUT);
          const err = truncate(rawStderr, MAX_OUTPUT);
          if (error) {
            const code =
              error.code === undefined ? '' : ` (exit code ${error.code})`;
            settle({
              ok: false,
              output: `${out}${err ? '\n' : ''}${err}${code}`,
            });
          } else {
            settle({
              ok: true,
              output: `${out}${err ? '\n' : ''}${err}`.trim(),
            });
          }
        },
      );

      timeoutId = setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
        settle({ ok: false, output: 'timeout' });
      }, timeoutMs);
    });
  },
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...truncated`;
}
