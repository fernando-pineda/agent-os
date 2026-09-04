export interface GlobalConfig {
  provider: 'fireworks' | 'zai';
  apiKey: string;
  defaultModel: string;
  createdAt: string;
  mcpServers?: McpServerConfig[];
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

export type McpStatus = 'online' | 'offline' | 'unknown';

export interface McpStatusResponse {
  statuses: Record<string, McpStatus>;
}

export interface AgentAvatar {
  character: string;
  color: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  group?: string;
  workspace?: string;
  role?: string;
  model?: string;
  supportsVision?: boolean;
  git?: {
    userName?: string;
    userEmail?: string;
    credential?: string;
    sshKeyPath?: string;
  };
  sandboxed?: boolean;
  avatar?: AgentAvatar;
  instructions?: string;
  plugins?: string[];
  reminders?: string[];
  createdAt: string;
}

export type AgentStatus =
  | 'starting'
  | 'online'
  | 'busy'
  | 'compressing'
  | 'error'
  | 'stopped';

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

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatImage {
  data: string; // raw base64, no data: prefix
  mimeType: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: ChatImage[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TurnSegment {
  kind: 'text' | 'tool';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  images?: ChatImage[];
}

/** @deprecated Use AgentSessionEvent from the Pi session adapter. */
export type LLMEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | {
      type: 'done';
      usage?: { promptTokens?: number; completionTokens?: number };
    }
  | { type: 'error'; error: string };

/** @deprecated Use PiSessionConfig from the Pi session adapter. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
}

/** @deprecated Use PiSessionHandle from the Pi session adapter. */
export interface LLMClient {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  isError?: boolean;
  images?: ChatImage[];
}

export interface ToolContext {
  agentId: string;
  workspace: string;
  homeDir: string;
  group?: string | undefined;
  signal?: AbortSignal | undefined;
  env?: Record<string, string> | undefined;
  sendAgentMessage?: (
    toAgentId: string,
    message: string,
    opts?: { replyDepth?: number; taskId?: string },
  ) => Promise<string>;
  /** Depth of the current agent-to-agent reply chain, for loop guards. */
  replyDepth?: number;
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

export interface AutomationStore {
  automations: Automation[];
}
