export interface PluginInfo {
  name: string;
  description: string;
}

export const PLUGINS: PluginInfo[] = [
  {
    name: 'shell',
    description: 'Run a zsh shell command in the agent home directory',
  },
  {
    name: 'file_read',
    description: 'Read a file within the agent home directory',
  },
  {
    name: 'file_write',
    description: 'Write a file within the agent home directory',
  },
  {
    name: 'file_list',
    description: 'List files in a directory within the agent home directory',
  },
  {
    name: 'simctl',
    description: 'Control the iOS simulator via xcrun simctl',
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of a web page using Playwright webkit',
  },
  {
    name: 'message_agent',
    description:
      "Send a message to another agent and continue without waiting. The other agent's reply arrives later as an inbound message to your inbox.",
  },
  {
    name: 'agent_list',
    description: 'List all agents managed by the supervisor',
  },
  {
    name: 'agent_create',
    description: 'Create a new agent managed by the supervisor',
  },
  {
    name: 'agent_update',
    description: 'Update an existing agent managed by the supervisor',
  },
  {
    name: 'agent_delete',
    description: 'Delete an agent managed by the supervisor',
  },
];

export const PLUGIN_NAMES: Set<string> = new Set(PLUGINS.map((p) => p.name));
