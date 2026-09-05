export type AgentStatus =
  | 'starting'
  | 'running'
  | 'online'
  | 'busy'
  | 'compressing'
  | 'error'
  | 'stopped';

export interface AgentAvatar {
  character: string;
  color: string;
}

export type ContainerStatus =
  | 'none'
  | 'pulling'
  | 'starting'
  | 'running'
  | 'failed';

export type ReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface AgentInfo {
  id: string;
  name: string;
  group?: string;
  workspace: string;
  role?: string;
  status: AgentStatus;
  model: string;
  reasoningLevel?: ReasoningLevel;
  tmuxSession: string;
  currentTaskId?: string;
  lastEventAt?: string;
  avatar?: AgentAvatar;
  instructions?: string;
  plugins?: string[];
  subagents?: string[];
  reminders?: string[];
  desktopPort?: number;
  sandboxType?: 'host' | 'docker-desktop';
  kasmImage?: string;
  containerStatus?: ContainerStatus;
}

export interface OnboardingStatus {
  configured: boolean;
}

export interface OnboardingPayload {
  defaultModel?: string;
}

export interface ModelItem {
  id: string;
  supportsTools: boolean;
  supportsVision?: boolean;
  provider?: string;
  name?: string;
  contextWindow?: number;
}

export interface ModelsResponse {
  models: ModelItem[];
}

export interface AgentsResponse {
  agents: AgentInfo[];
}

export interface CreateAgentPayload {
  name: string;
  group?: string;
  workspace?: string;
  role?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  sandboxType?: 'host' | 'docker-desktop';
  kasmImage?: string;
  avatar?: AgentAvatar;
  plugins?: string[];
  subagents?: string[];
  reminders?: string[];
}

export interface UpdateAgentPayload {
  name?: string;
  group?: string;
  workspace?: string;
  role?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel | null;
  sandboxType?: 'host' | 'docker-desktop';
  kasmImage?: string;
  sandboxed?: boolean;
  avatar?: AgentAvatar;
  instructions?: string;
  plugins?: string[];
  subagents?: string[];
  reminders?: string[];
}

export interface GlobalConfigStatus {
  defaultModel?: string;
  reminders?: string[];
}

export interface UpdateConfigPayload {
  defaultModel?: string;
  reminders?: string[];
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServersResponse {
  servers: McpServerConfig[];
}

export interface SubagentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

export interface SubagentsResponse {
  subagents: SubagentConfig[];
}

export type McpStatus = 'online' | 'offline' | 'unknown';

export interface McpStatusResponse {
  statuses: Record<string, McpStatus>;
}

export type AutomationDelivery = 'inbox' | 'silent';

export interface Automation {
  id: string;
  name: string;
  cron: string;
  tool?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  cursor?: string;
  delivery: AutomationDelivery;
  enabled: boolean;
  lastRunAt?: string;
  lastSummary?: string;
  createdAt: string;
}

export interface CreateAutomationPayload {
  name: string;
  cron: string;
  prompt?: string;
  tool?: string;
  args?: Record<string, unknown>;
  delivery?: AutomationDelivery;
  enabled?: boolean;
}

export type UpdateAutomationPayload = Partial<CreateAutomationPayload>;

export interface AgentTool {
  name: string;
  description: string;
}

export interface AutomationsResponse {
  automations: Automation[];
}

export interface AgentToolsResponse {
  tools: AgentTool[];
}

export interface RunAutomationResponse {
  ok: boolean;
  summary?: string;
}

export type SubagentJsonValue =
  | string
  | number
  | boolean
  | null
  | SubagentJsonObject
  | SubagentJsonValue[];

export interface SubagentJsonObject {
  [key: string]: SubagentJsonValue;
}

export interface SubagentStreamEvent {
  runId: string;
  type:
    | 'text'
    | 'tool-call'
    | 'tool-args'
    | 'tool-call-end'
    | 'tool-start'
    | 'tool-end'
    | 'usage'
    | 'done'
    | 'settled';
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: SubagentJsonObject;
  result?: string;
  images?: Array<{ data: string; mimeType: string }>;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface ActiveSubagentRun {
  runId: string;
  name: string;
  task: string;
  status: 'running' | 'done' | 'stopped';
  startedAt: number;
  events: SubagentStreamEvent[];
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SubagentSnapshot {
  type: 'snapshot';
  runs: ActiveSubagentRun[];
}
