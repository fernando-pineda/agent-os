# agent-os

macOS AI agents. A monorepo with an agent loop, Fireworks tool calling, Redis transport, a supervisor, and a web UI.

## Architecture

```
+---------+        +-------------+        +----------+
|   web   |<------>|  supervisor |<------>|  agents  |
+---------+        +-------------+        +----------+
                            |                   |
                            v                   v
                       +---------+         +---------+
                       |  Redis  |         |  tmux   |
                       | queue   |         | sessions|
                       +---------+         +---------+
```

## Isolation model

The workspace is the unit of isolation. Each workspace is backed by a real macOS user `agentos-<workspace>` with home directory `/Users/agentos-<workspace>`.

- Default: an agent without an explicit `workspace` gets its own workspace equal to its id.
- Team: agents sharing the same `workspace` run as the same macOS user, share home/git/browser, and differentiate by `role`.
- Agents in the same workspace coordinate only through Redis (`agent:{id}:inbox`).
- Agents cannot read other workspaces or the human home beyond macOS defaults.
- The supervisor runs as the human user and keeps only metadata in `~/.agent-os/`.

## Packages

| Package | Path | Description |
| ------- | ---- | ----------- |
| @agent-os/core | packages/core | Types, LLM clients, agent loop |
| @agent-os/tools | packages/tools | Shell, files, simctl, screenshot, message_agent, tmux |
| @agent-os/sandbox | packages/sandbox | Workspace user provisioning and sandbox-exec wrappers |
| @agent-os/transport | packages/transport | Redis task queue and pub/sub |
| supervisor | apps/supervisor | HTTP API and agent management |
| web | apps/web | React + assistant-ui chat interface |

## Prerequisites

- Node.js >=22 (see `.nvmrc`)
- pnpm 9.15.0
- tmux and Redis
- sudo access (for provisioning workspace macOS users)

```bash
brew install tmux redis
redis-server --daemonize yes
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
