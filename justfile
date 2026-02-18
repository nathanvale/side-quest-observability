# Side Quest Observability System
set dotenv-load
set quiet

server_port := env("OBSERVABILITY_PORT", "7483")
project_root := justfile_directory()

# Default recipe: show available commands
default:
    @just --list

# -- Development -----------------------------------------------

# Start server in foreground with auto-restart on file changes (Ctrl+C to stop)
dev:
    @echo "Starting server on port {{server_port}}..."
    @cd {{project_root}} && OBSERVABILITY_PORT={{server_port}} bun run --watch packages/server/src/cli/index.ts server --port {{server_port}}

# Build the Vue dashboard to packages/client/dist/
build-client:
    @cd {{project_root}}/packages/client && bun run build
    @echo "Client built to packages/client/dist/"

# Build everything (client first, then server)
build: build-client
    @cd {{project_root}}/packages/server && bun run build
    @echo "Full build complete"

# -- Quality ---------------------------------------------------

# Run all tests
test:
    @cd {{project_root}} && bun test

# TypeScript type checking
typecheck:
    @cd {{project_root}} && bun run typecheck

# Full validation (lint + types + build + test)
validate:
    @cd {{project_root}} && bun run validate

# -- Diagnostics -----------------------------------------------

# Check server health
health:
    @curl -sf http://127.0.0.1:{{server_port}}/health 2>/dev/null \
      && echo "Server: UP (port {{server_port}})" \
      || echo "Server: DOWN (port {{server_port}})"

# Send a test event through the full pipeline
test-event:
    @curl -s -X POST http://127.0.0.1:{{server_port}}/events \
      -H "Content-Type: application/json" \
      -d '{ \
        "schemaVersion": "1.0.0", \
        "id": "test-'"$(date +%s)"'", \
        "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'", \
        "type": "hook.session_start", \
        "app": "test", \
        "appRoot": "/tmp", \
        "source": "hook", \
        "correlationId": "test-session-001", \
        "data": {"hookEvent": "session_start", "sessionId": "test-001", "model": "claude-opus-4-6", "source": "cli"} \
      }' | head -c 200
    @echo ""

# Reset the event database -- JSONL files (server must be stopped first)
db-reset:
    @if [ -f ~/.cache/side-quest-observability/events.pid ]; then \
      echo "Error: Server appears to be running. Stop it first (Ctrl+C on just dev)." && exit 1; \
    fi
    @rm -f ~/.cache/side-quest-observability/events.jsonl
    @rm -f ~/.cache/side-quest-observability/events.jsonl.*
    @echo "Event persistence files cleared (including rotated files)"

# -- Voice TTS -------------------------------------------------

# Pre-generate voice clips for all characters (requires ELEVENLABS_API_KEY)
voice-generate:
    @if [ -z "${ELEVENLABS_API_KEY:-}" ]; then \
      echo "Error: ELEVENLABS_API_KEY is not set." && \
      echo "Usage: ELEVENLABS_API_KEY=sk-... just voice-generate" && exit 1; \
    fi
    @cd {{project_root}} && bun run scripts/generate-clips.ts
    @echo "Voice clips generated to ~/.cache/side-quest-observability/voices/"

# Show what voice clips would be generated (no API calls)
voice-dry-run:
    @cd {{project_root}} && ELEVENLABS_API_KEY=dry bun run scripts/generate-clips.ts --dry-run

# Clear all cached voice clips
voice-clear:
    @rm -rf ~/.cache/side-quest-observability/voices/
    @echo "Voice clip cache cleared"
