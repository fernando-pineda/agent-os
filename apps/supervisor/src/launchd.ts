import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function generatePlist(agentId: string): string {
  const agentDistPath = fileURLToPath(
    new URL('../node_modules/@agent-os/agent/dist/main.js', import.meta.url),
  );
  const homeDir = join(homedir(), '.agent-os', 'agents', agentId);
  const logPath = join(homeDir, 'launchd.log');

  const escapeXml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-os.${escapeXml(agentId)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(agentDistPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_ID</key>
    <string>${escapeXml(agentId)}</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homeDir)}</string>
</dict>
</plist>`;
}

function plistPath(agentId: string): string {
  return join(
    homedir(),
    'Library',
    'LaunchAgents',
    `com.agent-os.${agentId}.plist`,
  );
}

export async function installLaunchdAgent(
  agentId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    const path = plistPath(agentId);
    const plist = generatePlist(agentId);
    await writeFile(path, plist, 'utf-8');
    const uid = process.getuid?.() ?? userInfo().uid;
    await runCommand('plutil', ['-lint', path]);
    await runCommand('launchctl', ['bootstrap', `gui/${uid}`, path]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

export async function uninstallLaunchdAgent(
  agentId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const path = plistPath(agentId);
    const uid = process.getuid?.() ?? userInfo().uid;
    await runCommand('launchctl', ['bootout', `gui/${uid}`, path]).catch(
      () => undefined,
    );
    await rm(path, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr}`));
      }
    });
  });
}
