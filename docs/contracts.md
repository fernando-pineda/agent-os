# agent-os fixed contracts

These contracts are frozen before the build swarm. All builders must implement against them exactly. Changes go through the orchestrator only.

## Naming

- Monorepo name: `agent-os`
- Package scope: `@agent-os/*`
- Runtime state root (supervisor side, human user): `~/.agent-os/`
  - `~/.agent-os/config.json` global onboarding config
  - `~/.agent-os/agents/<id>/config.json` supervisor-owned registry copy of per-agent config
- Agent side: macOS user `agentos-<id>`, home `/Users/agentos-<id>/` (the real isolated workspace; cwd of everything the agent does)

## Ports

- supervisor HTTP API: `8787`
- web dev server: `3000`

## Global config (~/.agent-os/config.json)

```ts
interface GlobalConfig {
  provider: "fireworks";
  apiKey: string;
  defaultModel: string;
  createdAt: string; // ISO 8601
}
```

## Per-agent config (~/.agent-os/agents/<id>/config.json)

```ts
interface AgentConfig {
  id: string;          // slug, e.g. "agent-1"
  name: string;        // display name
  group?: string;      // organizational label only (UI filter), e.g. "research"
  workspace?: string;  // shared macOS user/home; default = own id (solo)
  role?: string;       // responsibility inside a team workspace, shapes the system prompt
  model?: string;      // overrides GlobalConfig.defaultModel when set
  git?: {
    userName?: string;     // commits authored as this identity
    userEmail?: string;
    credential?: string;   // HTTPS token, stored in the agent user's own .git-credentials
    sshKeyPath?: string;   // key in the agent user's ~/.ssh, referenced from its ssh config
  };
  sandboxed?: boolean;   // wrap task shell commands in sandbox-exec profile
  createdAt: string;
}
```

## Per-agent git isolation

Each agent is its own macOS user, so git identity, credentials, SSH keys and keychain are isolated by the OS. AgentConfig.git values are written into the agent user's home at provisioning time. No shared git state across agents or with the human account.

## Agent status enum

```ts
type AgentStatus = "starting" | "online" | "busy" | "error" | "stopped";
```

## Agent info (supervisor read model)

```ts
interface AgentInfo {
  id: string;
  name: string;
  group?: string;
  workspace: string;   // resolved (own id when solo)
  role?: string;
  status: AgentStatus;
  model: string;       // resolved model (agent override or default)
  tmuxSession: string; // e.g. "agent-os-<id>"
  currentTaskId?: string;
  lastEventAt?: string;
}
```

## LLM client interface (packages/core)

```ts
interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];       // assistant messages that requested tools
  toolCallId?: string;          // tool messages: id of the call being answered
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>; // parsed JSON
}

type LLMEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; call: ToolCall }   // emitted once per complete call, after accumulation
  | { type: "done"; usage?: { promptTokens?: number; completionTokens?: number } }
  | { type: "error"; error: string };

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number; // default 0.1
}

interface LLMClient {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}
```

Implementations in packages/core: `FireworksLLMClient` (openai npm pointed at Fireworks) and `MockLLMClient` (deterministic, for verification without a key; echoes and can exercise one shell tool call).

## Tool interface (packages/core, implemented by packages/tools)

```ts
interface ToolResult {
  ok: boolean;
  output: string;   // text returned to the LLM
  isError?: boolean;
}

interface ToolContext {
  agentId: string;
  workspace: string; // resolved workspace name
  homeDir: string;   // /Users/agentos-<workspace>
  signal?: AbortSignal;
}

interface Tool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

## Communication model (no Redis, no BullMQ)

Everything is direct HTTP. packages/transport is DELETED.

- Registry file `~/.agent-os/registry.json` (supervisor-owned):
  `{ "agents": [{ "id": string, "port": number, "pid": number }] }`
- Ports: agents get 9100+ sequential. Supervisor stays on 8787. Web on 3000.

### Agent HTTP server (apps/agent, one process per agent)

- `POST /chat` AI SDK data-stream protocol. Body `{ messages: UIMessage[] }`. Runs the agent loop, streams AI SDK frames (text `0:`, tool `b:/c:/a:`) via assistant-stream DataStreamResponse. Persists the thread to `<workspaceHome>/thread.json` on completion.
- `GET /messages` returns the persisted thread messages (UIMessage[]) for UI history load.
- `POST /inbox` agent-to-agent. Body `{ fromAgentId, taskId, message }`. Injects as a user message prefixed `Message from agent <from>:` into the loop and returns the reply text. The reply is also persisted to the thread.
- `GET /health` -> `{ ok: true, status: AgentStatus, currentTaskId?: string }`
- Concurrency: one run at a time; concurrent /chat or /inbox gets 409.

### Agent-to-agent (message_agent tool)

The tool context hook `sendAgentMessage(toAgentId, message)` reads the registry file, POSTs to `http://localhost:<port>/inbox`, returns the reply as ToolResult. In the UI it renders as a normal tool-call part ("message sent to X", then the reply as result).

### Supervisor (apps/supervisor, no queue, no Redis)

Keeps: onboarding, models, agents CRUD, start/stop (spawn/kill processes, write registry), launchd endpoints.
Changes:
- `GET /api/agents` reads registry + polls each agent `GET /health` (2s interval, cached) for live status.
- `GET /api/agents/events` SSE stream of AgentInfo snapshots on change.
- Chat proxy: `POST /api/agents/{id}/chat` forwards body to the agent's `/chat` and pipes the stream back (avoids CORS/port juggling in the UI). Same for `GET /api/agents/{id}/messages`.

### Web UI (apps/web)

- AI SDK: `useChatRuntime` from `@assistant-ui/react-ai-sdk` wrapping `useChat` from `@ai-sdk/react`.
- api per selected agent: `/backend/api/agents/{id}/chat`.
- History: on agent select, GET `/backend/api/agents/{id}/messages` and hydrate useChat.
- Thread component unchanged. RuntimeProvider rewritten around useChatRuntime.

```ts
interface TaskJob {
  taskId: string;     // uuid
  agentId: string;    // target agent (role routing inside a team workspace)
  threadId: string;   // conversation id from the web UI
  message: string;    // user message text
  history: ChatMessage[]; // prior thread messages
  model?: string;     // resolved by supervisor before enqueue
}
```

## Agent status enum (unchanged)

`AgentStatus` values stay: starting | online | busy | error | stopped. Status now lives in the registry file + /health polling, no pub/sub.

## launchd (unchanged)

Plists under ~/Library/LaunchAgents/com.agent-os.<id>.plist, bootstrap only on explicit user action.

```ts
type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "text-delta"; taskId: string; delta: string }
  | { type: "tool-call"; taskId: string; call: ToolCall; status: "running" | "complete" | "error" }
  | { type: "tool-result"; taskId: string; toolCallId: string; result: ToolResult }
  | { type: "done"; taskId: string }
  | { type: "error"; taskId?: string; error: string };

// Envelope on the wire:
interface AgentEventEnvelope {
  agentId: string;
  event: AgentEvent;
  ts: string; // ISO 8601
}

type AgentCommand = { type: "cancel"; taskId: string };
```

## Supervisor HTTP API

- `GET /api/onboarding/status` -> `{ configured: boolean }`
- `POST /api/onboarding` body `{ provider: "fireworks", apiKey: string, defaultModel: string }` -> writes `~/.agent-os/config.json`, returns `{ ok: true }`
- `GET /api/models` -> `{ models: { id: string; supportsTools: boolean }[] }` proxied from Fireworks, cached 5 min
- `GET /api/agents` -> `{ agents: AgentInfo[] }`
- `POST /api/agents` body `{ name: string; group?: string; model?: string }` -> creates agent (home dir, config, tmux session, process), returns `AgentInfo`
- `POST /api/agents/{id}/stop` and `POST /api/agents/{id}/start`
- `GET /api/agents/events` SSE stream of `AgentInfo` snapshots (sidebar)
- `POST /api/agents/{id}/chat` proxy to the agent AI SDK endpoint (streams through)
- `GET /api/agents/{id}/messages` proxy to the agent persisted thread
- `GET /api/health` -> `{ ok: true }`

## Versions (pinned)

- node >=22 (`.nvmrc` pins 22)
- pnpm 9.15.0 (`packageManager` field)
- openai ^7.8.0, bullmq ^6.3.1, redis ^6.2.1, ioredis ^5, playwright ^1.62.1, turbo ^2.10.12, typescript ~5.7
- assistant-ui packages and `assistant-stream`: exact-pinned by web builder at scaffold time, versions recorded in apps/web/package.json (wire format `aui-state` is unstable and migrates to SSE later)

## Isolation model (hard requirement)

Unit of isolation is the WORKSPACE, backed by a real macOS user `agentos-<workspace>` (created via sysadminctl, dscl fallback), home `/Users/agentos-<workspace>`. Everything agents touch lives in that home: clones, git config, credentials, keychain, browser profile (Playwright userDataDir), tmux server. Workspaces cannot read each other's homes nor the human's beyond macOS defaults.

- Default: agent without `workspace` gets its own workspace equal to its id (full isolation).
- Team: agents sharing `workspace: "<name>"` run as the same macOS user, share home/git/browser, differentiate by `role` (own system prompt) and coordinate via their personal inboxes.
- Supervisor runs as the human user, keeps only metadata in `~/.agent-os/`. Agent-private files stay in the workspace user home.

- AgentConfig.git credentials land in the agent user's own .gitconfig/.git-credentials, not shared.
- sandbox-exec profile applied per task execution as defense-in-depth on top of OS-user isolation (optional, per-agent flag `sandboxed?: boolean`, default false in MVP).
- packages/sandbox is now FUNCTIONAL for user management (requires sudo; commands surfaced to the human for confirmation before running) and provides sandbox-exec wrappers.
