export interface GlobalConfig {
  provider: 'fireworks';
  apiKey: string;
  defaultModel: string;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  group?: string;
  workspace?: string;
  role?: string;
  model?: string;
  git?: {
    userName?: string;
    userEmail?: string;
    credential?: string;
    sshKeyPath?: string;
  };
  sandboxed?: boolean;
  createdAt: string;
}

export type AgentStatus = 'starting' | 'online' | 'busy' | 'error' | 'stopped';

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
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LLMEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | {
      type: 'done';
      usage?: { promptTokens?: number; completionTokens?: number };
    }
  | { type: 'error'; error: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
}

export interface LLMClient {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  isError?: boolean;
}

export interface ToolContext {
  agentId: string;
  workspace: string;
  homeDir: string;
  signal?: AbortSignal | undefined;
  env?: Record<string, string> | undefined;
  sendAgentMessage?: (toAgentId: string, message: string) => Promise<string>;
}

export interface Tool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface AgentMessageEnvelope {
  fromAgentId: string;
  taskId: string;
  message: string;
  ts: string;
}
