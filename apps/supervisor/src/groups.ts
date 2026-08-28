import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface GroupsFile {
  groups: { name: string; createdAt: string }[];
}

const groupsPath = join(homedir(), '.agent-os', 'groups.json');

export async function loadGroups(): Promise<string[]> {
  try {
    const raw = await readFile(groupsPath, 'utf-8');
    const parsed = JSON.parse(raw) as GroupsFile;
    return parsed.groups.map((g) => g.name);
  } catch {
    return [];
  }
}

async function saveGroups(names: string[]): Promise<void> {
  await mkdir(join(homedir(), '.agent-os'), { recursive: true });
  const data: GroupsFile = {
    groups: names.map((name) => ({
      name,
      createdAt: new Date().toISOString(),
    })),
  };
  await writeFile(groupsPath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function createGroup(name: string): Promise<'created' | 'exists'> {
  const groups = await loadGroups();
  if (groups.includes(name)) return 'exists';
  await saveGroups([...groups, name]);
  return 'created';
}

export async function deleteGroup(name: string): Promise<void> {
  const groups = await loadGroups();
  await saveGroups(groups.filter((g) => g !== name));
}
