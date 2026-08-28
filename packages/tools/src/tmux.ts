import { execFile } from 'node:child_process';

interface ExecResult {
  stdout: string;
  stderr: string;
}

function exec(
  command: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, opts ?? {}, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export class TmuxSession {
  readonly name: string;
  readonly cwd: string;

  private constructor(name: string, cwd: string) {
    this.name = name;
    this.cwd = cwd;
  }

  static async create(name: string, cwd: string): Promise<TmuxSession> {
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', cwd], { cwd });
    return new TmuxSession(name, cwd);
  }

  static async exists(name: string): Promise<boolean> {
    try {
      await exec('tmux', ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  async sendKeys(text: string): Promise<void> {
    await exec('tmux', ['send-keys', '-t', this.name, '-l', text]);
    await exec('tmux', ['send-keys', '-t', this.name, 'Enter']);
  }

  async capture(lines = 100): Promise<string> {
    const { stdout } = await exec('tmux', [
      'capture-pane',
      '-p',
      '-t',
      this.name,
      '-S',
      `-${lines}`,
    ]);
    return stdout;
  }

  async kill(): Promise<void> {
    await exec('tmux', ['kill-session', '-t', this.name]);
  }
}
