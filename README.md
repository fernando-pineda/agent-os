# agent-os

macOS AI agents. A monorepo with an agent loop, Fireworks tool calling, a supervisor, a web UI, MCP plugins, and cron automations. Direct HTTP between processes, no Redis, no queue service.

## Architecture

```
+---------+        +-------------+        +----------------------+
|   web   |<------>|  supervisor |<------>|  agents (1 process   |
| :3000   |  HTTP  |   :8787     |  HTTP  |  each, :9100+)       |
+---------+        +-------------+        +----------------------+
                            |                   |            |
                            v                   v            v
                    ~/.agent-os/          MCP servers    tmux session
                    registry.json         (plugins)      per agent
```

Everything is direct HTTP on localhost. The supervisor owns the registry and proxies the web UI to each agent's own HTTP server. Agent-to-agent messages go agent -> target `/inbox`, with a per-agent JSONL outbox as the busy/offline fallback.

## Isolation model

The workspace is the unit of isolation. Each workspace gets its own dev-home at `~/.agent-os/dev-homes/<workspace>` (thread, memory, outbox, git config, usage log).

- Default: an agent without an explicit `workspace` gets its own workspace equal to its id.
- Team: agents sharing the same `workspace` share the same dev-home, git, and browser profile, and differentiate by `role`.
- Agents coordinate over HTTP (`/inbox`), never shared memory or a queue.
- The supervisor runs as the human user and keeps metadata in `~/.agent-os/`.

## How it works

- Each agent is its own Node process with an HTTP server, a tmux session, a persisted thread, and a token-usage log.
- The LLM loop (packages/core) streams text and tool calls; built-in tools plus active MCP plugin tools are exposed to the model.
- MCP plugins are configured globally and activated per agent. Toggling plugins hot-reloads the agent's MCP connections via `POST /plugins/reload`, no restart needed.
- Agent name, role, instructions, and reminders are re-read from config on every turn, so edits apply without a restart.
- A running turn can be cancelled from the web composer stop button, which calls `POST /abort` and propagates an AbortSignal to the LLM stream and the in-flight tool.

### Automations

Cron-triggered wake-ups, in-process via croner (no OS crontab). An automation delivers a prompt to the agent's own `/inbox` on schedule, waking it to act with its connected plugins. Automations persist at the agent's home as `automations.json`. They only tick while the agent process is alive; there is no catch-up for missed runs.

### Agent-to-agent queue

`message_agent` POSTs to the target `/inbox`. A 409 (busy) now queues the message in the sender's outbox (`outbox.jsonl`) instead of failing; a 15s drain loop retries delivery once the recipient is free, plus a drain on startup.

## Packages

| Package | Path | Description |
| ------- | ---- | ----------- |
| @agent-os/core | packages/core | Types, LLM clients, agent loop |
| @agent-os/tools | packages/tools | shell, files, simctl, screenshot, tmux, agents, message_agent, mcps, automations |
| @agent-os/sandbox | packages/sandbox | Workspace user provisioning and sandbox-exec wrappers |
| supervisor | apps/supervisor | HTTP API, registry, agent management, web proxy |
| agent | apps/agent | Per-agent process: loop, HTTP server, MCP client, automations scheduler |
| web | apps/web | Next.js + assistant-ui chat interface |

## Prerequisites

- Node.js >=22 (see `.nvmrc`)
- pnpm 9.15.0
- tmux

```bash
brew install tmux
```

- Playwright WebKit

```bash
pnpm exec playwright install webkit
```

## Quickstart

```bash
pnpm install
pnpm build

# Create the global config via the web onboarding UI, then:
pnpm dev
```

This starts the supervisor, an agent, and the web app in parallel.

## Useful scripts

- `pnpm supervisor:restart` restart the supervisor without touching running agents or state.
