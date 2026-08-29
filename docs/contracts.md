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
  provider: "fireworks" | "zai";
  apiKey: string;
  defaultModel: string;
  createdAt: string; // ISO 8601
  mcpServers?: McpServerConfig[]; // configured MCP servers (global)
  reminders?: string[]; // short texts injected into every agent turn
}

interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;   // stdio
  args?: string[];    // stdio
  env?: Record<string, string>; // stdio
  url?: string;       // http
  headers?: Record<string, string>; // http
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
  supportsVision?: boolean; // whether the resolved model accepts image inputs
  git?: {
    userName?: string;     // commits authored as this identity
    userEmail?: string;
    credential?: string;   // HTTPS token, stored in the agent user's own .git-credentials
    sshKeyPath?: string;   // key in the agent user's ~/.ssh, referenced from its ssh config
  };
  sandboxed?: boolean;   // wrap task shell commands in sandbox-exec profile
  plugins?: string[];    // enabled MCP server names; absent/undefined = all enabled
  reminders?: string[]; // per-agent reminders, applied on restart
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
  reminders?: string[]; // per-agent silent reminders, injected into every turn
  status: AgentStatus;
  model: string;       // resolved model (agent override or default)
  tmuxSession: string; // e.g. "agent-os-<id>"
  currentTaskId?: string;
  lastEventAt?: string;
  plugins?: string[];    // enabled MCP server names; absent/undefined = all enabled
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

interface ChatImage {
  data: string;       // raw base64, no data: prefix
  mimeType: string;   // e.g. "image/png"
}

interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: ChatImage[];       // user messages with image attachments (vision models only)
  toolCalls?: ToolCall[];     // assistant messages that requested tools
  toolCallId?: string;        // tool messages: id of the call being answered
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

Implementations in packages/core: `FireworksLLMClient` (openai npm pointed at Fireworks, sends images as `image_url` content parts) and `ZaiLLMClient` (Anthropic SDK pointed at z.ai, sends images as `image` source blocks). `MockLLMClient` (deterministic, for verification without a key; echoes and can exercise one shell tool call).

## Tool interface (packages/core, implemented by packages/tools)

```ts
interface ToolResult {
  ok: boolean;
  output: string;   // text returned to the LLM
  isError?: boolean;
  images?: ChatImage[]; // base64 images surfaced to the chat UI (not sent to the LLM)
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

## MCP runtime wiring (agent startup)

When an agent has `plugins?: string[]` (active MCP server names), the agent process connects to those MCP servers at startup and exposes their tools to the LLM loop. Servers are looked up from `GlobalConfig.mcpServers` by name.

- stdio transport: spawned via `StdioClientTransport({ command, args, env, stderr: 'inherit' })`.
- http transport: connected via `StreamableHTTPClientTransport(url, { requestInit: { headers } })`.
- Each remote tool is exposed as `<serverName>__<toolName>` (e.g. `slack-eventors__slack_send_message`) to avoid name collisions with built-in tools.
- Tool results are mapped to `ToolResult { ok, output }`; MCP `isError` flags map to `ok: false`.
- Per-server connect timeout is 10s. A server that fails to connect logs a warning and contributes zero tools; it does not crash the agent or block other servers (`Promise.allSettled`).
- All MCP connections are closed on agent shutdown (SIGTERM / SIGINT).

## Communication model (no Redis, no BullMQ)

Everything is direct HTTP. packages/transport is DELETED.

- Registry file `~/.agent-os/registry.json` (supervisor-owned):
  `{ "agents": [{ "id": string, "port": number, "pid": number }] }`
- Ports: agents get 9100+ sequential. Supervisor stays on 8787. Web on 3000.

### Agent HTTP server (apps/agent, one process per agent)

- `POST /chat` AI SDK data-stream protocol. Body `{ messages: UIMessage[] }`. UIMessage parts may include `{ type: "image", image: <data-url>, mimeType }` for user messages. Runs the agent loop, streams AI SDK frames (text `0:`, tool `b:/c:/a:`, file `k:`) via assistant-stream DataStreamResponse. Tool results carrying `images` (e.g. the `screenshot` tool) are streamed as `k:` file parts and persisted as image parts on the assistant message. Persists the thread to `<workspaceHome>/thread.json` on completion. When the agent's model does not support vision, image parts are stripped before sending to the LLM but remain in the persisted thread.
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
- `POST /api/onboarding` body `{ provider: "fireworks" | "zai", apiKey: string, defaultModel: string }` -> writes `~/.agent-os/config.json`, returns `{ ok: true }`
- `GET /api/config` -> `{ provider: "fireworks" | "zai", apiKey: string (masked, last 4 chars), defaultModel: string, reminders?: string[] }` (404 `{ error: "not configured" }` if no config)
- `PATCH /api/config` body `{ provider?: "fireworks" | "zai", apiKey?: string, defaultModel?: string, reminders?: string[] }` -> updates config (provider validated to "fireworks" or "zai"; apiKey only overwritten when non-empty; reminders undefined means unchanged, [] clears), returns masked config same as GET
- `GET /api/mcp` -> `{ servers: McpServerConfig[] }` (empty array if none)
- `POST /api/mcp` body `McpServerConfig` -> validates, rejects duplicate name with 409, persists to `~/.agent-os/config.json`, returns 201 with the created server
- `PATCH /api/mcp/:name` body `Partial<McpServerConfig>` -> updates fields, rename allowed if new name not taken, 404 if not found, returns updated server
- `DELETE /api/mcp/:name` -> removes server, 404 if not found, returns `{ ok: true }`
- `GET /api/models` -> `{ models: { id: string; supportsTools: boolean; supportsVision?: boolean }[] }` proxied from Fireworks or z.ai static list, cached 5 min. `supportsVision` is set when the provider reports image input capability.
- `GET /api/agents` -> `{ agents: AgentInfo[] }`
- `POST /api/agents` body `{ name: string; group?: string; model?: string; avatar?: { character: string; color: string }; plugins?: string[]; reminders?: string[] }` -> creates agent (home dir, config, tmux session, process), returns `AgentInfo`. Avatar is always set: if omitted or invalid the server assigns a default (first character, zinc color); an explicitly invalid avatar returns 400
- `PATCH /api/agents/{id}` body `{ name?; group?; role?; instructions?; model?; workspace?; sandboxed?; avatar?; plugins?: string[]; reminders?: string[] }` -> updates config (plugins validated against GET /api/mcp server names, unknown names return 400; reminders undefined means unchanged, [] clears), returns updated `AgentConfig`
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

## Automations

Cron-triggered polling of MCP tools (e.g. Slack) without an LLM. Each automation calls a single MCP tool on a cron schedule, detects novelty since the last run via a cursor, and optionally delivers the result to the agent's inbox to wake it. No model tokens are spent; the agent loop is only invoked on delivery. Runs entirely inside the agent process using its existing MCP connections.

### Storage

- Automations are stored per agent in `<workspaceHome>/automations.json` as a JSON array of `Automation` objects.
- Writes are atomic (write to temp file, then rename).
- The scheduler library is `croner` (real cron syntax, TS-native). Each automation has a `Cron` instance with an arm/disarm pattern: armed when `enabled` and the agent is running, disarmed on stop or delete.

### Automation interface

```ts
type AutomationDelivery = "inbox" | "silent";

interface Automation {
  id: string;          // uuid
  name: string;        // human label
  cron: string;        // 5-field cron expression
  tool: string;        // MCP tool name, e.g. "slack-eventors__slack_search_messages"
  args: Record<string, unknown>; // tool arguments; "{{cursor}}" placeholder supported in any string value
  cursor?: string;     // opaque token persisted after each run; numeric timestamps compared numerically, never lexicographically
  delivery: AutomationDelivery;
  enabled: boolean;
  lastRunAt?: string;  // ISO 8601
  lastSummary?: string; // short text of the last run result or skip reason
  createdAt: string;   // ISO 8601
}
```

### Semantics

- Cursor injection: any string value in `args` containing the literal `{{cursor}}` is replaced with the stored `cursor` value before the tool call. On the first run `cursor` is undefined, so the placeholder resolves to an empty string. After each run, the tool result is parsed as JSON (with a regex fallback for non-JSON output) and the highest numeric `ts` field found is extracted as the new cursor; it is persisted back to `automations.json`.
- Cursor comparison is numeric when values look like timestamps (e.g. `1735689600.123456`). Two cursors are compared as floats, never as strings, so `"10"` is correctly newer than `"9"`.
- Delivery `inbox`: after a successful tool call that produced novelty (cursor advanced), the agent process POSTs a summary to its own `/inbox` endpoint, which wakes the agent loop and injects the summary as a user message. This is a self-delivery, not agent-to-agent.
- When the agent is busy (already running a turn, `/chat` or `/inbox` returns 409), the cursor still advances and is persisted, but delivery is skipped. `lastSummary` records the skip reason (e.g. `"agent busy, delivery skipped"`).
- Delivery `silent`: the tool result and updated cursor are persisted to `automations.json` only. The agent is never woken. Useful for collecting state without spending tokens.
- Disabled automations (`enabled: false`) are not scheduled; their `Cron` instance is disarmed.
- All automation `Cron` instances are stopped on agent shutdown (SIGTERM / SIGINT).

### Agent HTTP routes

- `GET /api/agents/:id/automations` -> `{ automations: Automation[] }`
- `POST /api/agents/:id/automations` body `CreateAutomationPayload` -> `Automation` (200). Validates cron syntax via `croner`; invalid cron returns 400.
- `GET /api/agents/:id/automations/:automationId` -> `Automation` (404 if not found)
- `PATCH /api/agents/:id/automations/:automationId` body `Partial<CreateAutomationPayload>` -> `Automation` (404 if not found). Re-arms the scheduler when `enabled` or `cron` changes.
- `DELETE /api/agents/:id/automations/:automationId` -> `{ ok: true }` (404 if not found). Disarms and removes from `automations.json`.
- `POST /api/agents/:id/automations/:automationId/run` -> `{ ok: boolean; summary?: string }` (200). Triggers an immediate run of the automation (bypasses the cron schedule), executes the tool, updates the cursor and `lastRunAt`/`lastSummary`, and performs delivery if applicable.
- `GET /api/agents/:id/tools` -> `{ tools: { name: string; description: string }[] }`. Lists all tools currently available to the agent (built-in + MCP remote tools as `<serverName>__<toolName>`).

### Supervisor proxy routes

The supervisor proxies the agent routes to avoid CORS and port juggling in the web UI:

- `GET /api/agents/:id/automations` -> forwards to agent `GET /automations`
- `POST /api/agents/:id/automations` -> forwards body to agent `POST /automations`
- `GET /api/agents/:id/automations/:automationId` -> forwards to agent `GET /automations/:automationId`
- `PATCH /api/agents/:id/automations/:automationId` -> forwards body to agent `PATCH /automations/:automationId`
- `DELETE /api/agents/:id/automations/:automationId` -> forwards to agent `DELETE /automations/:automationId`
- `POST /api/agents/:id/automations/:automationId/run` -> forwards to agent `POST /automations/:automationId/run`
- `GET /api/agents/:id/tools` -> forwards to agent `GET /tools`

### Built-in tools (agent LLM loop)

The agent exposes automation management as built-in tools so the LLM can self-manage automations during a conversation:

- `automation_list` -> returns all automations for this agent.
- `automation_create` -> creates a new automation (args: name, cron, tool, args, delivery, enabled).
- `automation_update` -> updates an existing automation by id.
- `automation_delete` -> deletes an automation by id.
- `automation_run` -> runs an automation immediately by id.

### Screenshot tool

The `screenshot` tool (packages/tools) captures a web page via Playwright and saves the PNG to `<homeDir>/<outputPath>`. After saving, it reads the file back and returns `ToolResult { ok: true, output: <path>, images: [{ data: <base64>, mimeType: "image/png" }] }`. The `images` field surfaces the capture in the chat UI (streamed live as a `k:` file part, persisted as an image part on the assistant message). Image parts on assistant messages are not re-sent to the LLM.
