# @side-quest/observability-server

HTTP + WebSocket event server for Side Quest observability, bundled with the dashboard SPA.

## Runtime

This package requires Bun at runtime.

- Install Bun: <https://bun.sh/docs/installation>
- Run with bunx: `bunx @side-quest/observability-server start`

## Quick Start

```bash
# start server (alias: `server`)
bunx @side-quest/observability-server start --port 7483

# health/status
bunx @side-quest/observability-server status --json

# query recent events
bunx @side-quest/observability-server events --jsonl --limit 50

# stop server
bunx @side-quest/observability-server stop --json --quiet
```

## CLI Commands

- `start` (alias: `server`) - start or reuse running server
- `status` - health + diagnostics
- `events` - query buffered events (`--jsonl`, `--type`, `--since`, `--limit`, `--fields`)
- `stop` - stop discovered server process
- `help [topic]` - targeted help (`overview`, `start`, `status`, `stop`, `events`, `api`, `contract`)

For full command docs:

```bash
observability --help
observability help api
observability help contract
observability events --help
```

## Agent Contract

Machine-readable output follows a strict envelope:

- Success on `stdout`: `{"status":"data","data":{...}}`
- Error on `stderr`: `{"status":"error","message":"...","error":{"name":"...","code":"..."}}`

Exit codes:

- `0` success
- `1` runtime error
- `2` usage/argument error
- `3` not found
- `4` unauthorized
- `5` conflict
- `130` interrupted

When stdout is non-TTY, CLI automatically emits machine-friendly output.

## HTTP API

- `GET /health` - server diagnostics
- `GET /events?type&since&limit` - query event buffer
- `POST /events` - submit envelope or `{type,data,...}`
- `POST /events/:eventName` - hook ingress
- `POST /voice/notify` - voice trigger
- `GET /ws` - live stream (`?type=<eventType>`)
- `GET /` - dashboard SPA (from embedded `dist/public`)

## Local `npm link` Workflow

From this package:

```bash
cd packages/server
bun run build
npm link
```

From a consumer project:

```bash
npm link @side-quest/observability-server
observability --help
observability start
```

Cleanup:

```bash
npm unlink @side-quest/observability-server
# and in packages/server:
npm unlink
```

## Release Smoke Checks

From `packages/server`:

```bash
# build + pack content verification + CLI smoke checks
bun run smoke:release
```

Individual checks:

```bash
bun run pack:verify
bun run smoke:cli
```

## Package Contents

Published tarballs include:

- `dist/` (library + CLI bundles)
- `dist/public/` (embedded dashboard assets)
- `bin/observability.cjs` (Node shim that forwards to Bun)
- `README.md`, `LICENSE`, `CHANGELOG.md`
