# side-quest-observability

Observability event pipeline for Side Quest plugins.

This repo is a Bun workspace with:
- `packages/server`: HTTP/WebSocket event server and CLI (`observability`)
- `packages/client`: Vue dashboard consumed by the server static route

## Requirements

- Bun `>=1.3.7`

## Install

```bash
bun install
```

## Development

```bash
# run all tests
bun test --recursive

# typecheck workspace
bun run typecheck

# lint/format checks
bunx biome ci .

# build client then server
bun run build
```

## Run the server

```bash
# from repo root
bun run packages/server/src/cli/index.ts server

# health
curl http://127.0.0.1:7483/health
```

## HTTP endpoints

- `POST /events/:eventName`: raw hook payload ingress
- `POST /events`: pre-built envelope ingress
- `GET /events`: query history (`type`, `since`, `limit`)
- `GET /health`: server status and nonce
- `GET /`: dashboard static assets (when built)

## Notes

- Hook scripts stay dumb by design; enrichment happens server-side.
- Server discovery files are written to `~/.cache/side-quest-observability/`.
- Signal handlers clean PID/port/nonce files on shutdown.
