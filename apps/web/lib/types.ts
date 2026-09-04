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

export interface AgentInfo {
  id: string;
  name: string;
  group?: string;
  workspace: string;
  role?: string;
  status: AgentStatus;
  model: string;
  tmuxSession: string;
  currentTaskId?: string;
  lastEventAt?: string;
  avatar?: AgentAvatar;
  instructions?: string;
  plugins?: string[];
  reminders?: string[];
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
  avatar?: AgentAvatar;
  plugins?: string[];
  reminders?: string[];
}

export interface UpdateAgentPayload {
  name?: string;
  group?: string;
  workspace?: string;
  role?: string;
  model?: string;
  sandboxed?: boolean;
  avatar?: AgentAvatar;
  instructions?: string;
  plugins?: string[];
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
