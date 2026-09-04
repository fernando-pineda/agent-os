export { agentCreate, agentDelete, agentList, agentUpdate } from './agents.js';
export {
  automationCreate,
  automationDelete,
  automationList,
  automationRun,
  automationUpdate,
} from './automations.js';
export { fileTools } from './files.js';
export { mcpCreate, mcpDelete, mcpList, mcpStatus, mcpUpdate } from './mcps.js';
export { messageAgent } from './message_agent.js';
export { screenshot } from './screenshot.js';
export { screenshot_desktop } from './screenshot_desktop.js';
export { shell } from './shell.js';
export { simctl } from './simctl.js';
export { subagentList, subagentRun } from './subagents.js';
export { taskCreate, taskGet, taskList, taskUpdate } from './tasks.js';
export { TmuxSession } from './tmux.js';

import type { Tool } from '@agent-os/core';
import { agentCreate, agentDelete, agentList, agentUpdate } from './agents.js';
import {
  automationCreate,
  automationDelete,
  automationList,
  automationRun,
  automationUpdate,
} from './automations.js';
import { fileTools } from './files.js';
import { mcpCreate, mcpDelete, mcpList, mcpStatus, mcpUpdate } from './mcps.js';
import { messageAgent } from './message_agent.js';
import { screenshot } from './screenshot.js';
import { screenshot_desktop } from './screenshot_desktop.js';
import { shell } from './shell.js';
import { simctl } from './simctl.js';
import { subagentList, subagentRun } from './subagents.js';
import { taskCreate, taskGet, taskList, taskUpdate } from './tasks.js';

/** Tools that have Pi built-in equivalents and should not be registered as custom. */
const PI_BUILTIN_REPLACED = new Set([
  'shell',
  'file_read',
  'file_write',
  'file_list',
]);

/**
 * Custom tools that Pi does not have built-in.
 * Pi provides bash, read, edit, write, ls, grep, find natively.
 * We only register tools that are agent-os specific.
 */
export function customTools(): Tool[] {
  return [
    ...defaultTools().filter((t) => !PI_BUILTIN_REPLACED.has(t.spec.name)),
    subagentList,
    subagentRun,
  ];
}

export function defaultTools(): Tool[] {
  return [
    shell,
    ...fileTools,
    simctl,
    screenshot,
    screenshot_desktop,
    messageAgent,
    agentList,
    agentCreate,
    agentUpdate,
    agentDelete,
    mcpList,
    mcpCreate,
    mcpUpdate,
    mcpDelete,
    mcpStatus,
    taskList,
    taskCreate,
    taskUpdate,
    taskGet,
    automationList,
    automationCreate,
    automationUpdate,
    automationDelete,
    automationRun,
  ];
}
