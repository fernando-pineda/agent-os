import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@agent-os/core';

export const simctl: Tool = {
  spec: {
    name: 'simctl',
    description: 'Control the iOS simulator via xcrun simctl',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'boot', 'shutdown', 'screenshot'],
        },
        device: { type: 'string' },
        outputPath: { type: 'string' },
      },
      required: ['action'],
    },
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const action = String(args.action ?? '');
    const device = typeof args.device === 'string' ? args.device : undefined;
    const outputPath =
      typeof args.outputPath === 'string' ? args.outputPath : undefined;

    const xcrunMissing = await checkXcrun();
    if (xcrunMissing) {
      return { ok: false, output: xcrunMissing };
    }

    try {
      switch (action) {
        case 'list': {
          const { stdout } = await execFilePromise(
            'xcrun',
            ['simctl', 'list', '--json'],
            {
              cwd: ctx.homeDir,
            },
          );
          return { ok: true, output: stdout };
        }
        case 'boot': {
          if (!device) return { ok: false, output: 'device required for boot' };
          await execFilePromise('xcrun', ['simctl', 'boot', device], {
            cwd: ctx.homeDir,
          });
          return { ok: true, output: `booted ${device}` };
        }
        case 'shutdown': {
          if (!device)
            return { ok: false, output: 'device required for shutdown' };
          await execFilePromise('xcrun', ['simctl', 'shutdown', device], {
            cwd: ctx.homeDir,
          });
          return { ok: true, output: `shutdown ${device}` };
        }
        case 'screenshot': {
          const targetPath = outputPath
            ? join(ctx.homeDir, outputPath)
            : join(ctx.homeDir, 'screenshot.png');
          await execFilePromise(
            'xcrun',
            ['simctl', 'io', 'booted', 'screenshot', targetPath],
            {
              cwd: ctx.homeDir,
            },
          );
          return { ok: true, output: targetPath };
        }
        default:
          return { ok: false, output: `unknown action: ${action}` };
      }
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

function checkXcrun(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('xcrun', ['--version'], (error) => {
      resolve(error ? 'xcrun not available' : undefined);
    });
  });
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFilePromise(
  file: string,
  args: string[],
  opts: { cwd: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
