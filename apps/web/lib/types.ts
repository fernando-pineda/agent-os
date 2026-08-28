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
}

export interface GlobalConfigStatus {
  provider: 'fireworks';
  apiKey: string;
  defaultModel: string;
}

export interface UpdateConfigPayload {
  apiKey?: string;
  defaultModel?: string;
}

export interface PluginInfo {
  name: string;
  description: string;
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}
