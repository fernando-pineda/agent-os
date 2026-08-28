export { agentCreate, agentDelete, agentList, agentUpdate } from './agents.js';
export { fileTools } from './files.js';
export { messageAgent } from './message_agent.js';
export { screenshot } from './screenshot.js';
export { shell } from './shell.js';
export { simctl } from './simctl.js';
export { TmuxSession } from './tmux.js';

import type { Tool } from '@agent-os/core';
import { agentCreate, agentDelete, agentList, agentUpdate } from './agents.js';
import { fileTools } from './files.js';
import { messageAgent } from './message_agent.js';
import { screenshot } from './screenshot.js';
import { shell } from './shell.js';
import { simctl } from './simctl.js';

export function defaultTools(): Tool[] {
  return [
    shell,
    ...fileTools,
    simctl,
    screenshot,
    messageAgent,
    agentList,
    agentCreate,
    agentUpdate,
    agentDelete,
  ];
}
