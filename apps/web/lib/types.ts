export type AgentStatus =
  | 'starting'
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
}
