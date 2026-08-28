# @agent-os/web

Next.js web UI for the agent-os supervisor.

## Pinned assistant-ui versions

- `@assistant-ui/react`: `0.15.17`
- `@assistant-ui/react-markdown`: `0.14.13`
- `@assistant-ui/store`: `0.3.11`
- `@assistant-ui/tap`: `0.9.15`
- `assistant-stream`: `0.3.40`

The assistant-ui `assistant-transport` wire format (`aui-state:` state snapshots) is currently unstable and will migrate to Server-Sent Events later. Keep these versions pinned.

## Development

```bash
npm run dev
```

The dev server runs on port 3000. The web UI proxies `/backend/*` to the supervisor API at `http://localhost:8787/*`.
