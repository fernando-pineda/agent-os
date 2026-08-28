import { execFile } from 'node:child_process';

export interface DsclUserSpec {
  username: string;
  realName: string;
  shell: string;
  homeDir: string;
}

export function usernameForWorkspace(workspace: string): string {
  return `agentos-${workspace}`;
}

export function homeDirForWorkspace(workspace: string): string {
  return `/Users/${usernameForWorkspace(workspace)}`;
}

export async function userExists(workspace: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('id', [usernameForWorkspace(workspace)], (error) => {
      resolve(error === null);
    });
  });
}

export async function ensureWorkspaceUser(workspace: string): Promise<{
  created: boolean;
  username: string;
  homeDir: string;
}> {
  if (process.getuid && process.getuid() !== 0) {
    throw new Error('sudo required to create workspace user');
  }

  const username = usernameForWorkspace(workspace);
  const homeDir = homeDirForWorkspace(workspace);
  const exists = await userExists(workspace);
  if (exists) {
    return { created: false, username, homeDir };
  }

  const password = generatePassword();
  await execFilePromise('sysadminctl', [
    '-addUser',
    username,
    '-fullName',
    `agent-os workspace ${workspace}`,
    '-password',
    password,
    '-home',
    homeDir,
    '-adminUser',
    'false',
  ]);

  return { created: true, username, homeDir };
}

export function buildDsclCommands(spec: DsclUserSpec, uid: number): string[] {
  return [
    `dscl . -create /Users/${spec.username} UserShell ${spec.shell}`,
    `dscl . -create /Users/${spec.username} RealName "${spec.realName}"`,
    `dscl . -create /Users/${spec.username} UniqueID ${uid}`,
    `dscl . -create /Users/${spec.username} PrimaryGroupID 20`,
    `dscl . -create /Users/${spec.username} NFSHomeDirectory ${spec.homeDir}`,
    `createhomedir -u ${spec.username} -c`,
  ];
}

function generatePassword(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function execFilePromise(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
