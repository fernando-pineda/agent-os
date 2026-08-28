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
  provider: 'fireworks';
  apiKey: string;
  defaultModel: string;
}

export interface ModelItem {
  id: string;
  supportsTools: boolean;
  serverless: boolean;
  contextLength?: number;
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
  provider: 'fireworks';
  apiKey: string;
  defaultModel: string;
  reminders?: string[];
}

export interface UpdateConfigPayload {
  apiKey?: string;
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
