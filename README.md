# claude-opencode-proxy

[![CI](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/ci.yml)
[![Publish container](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local proxy that lets **Claude Code** talk to **OpenCode Zen / Go / Free**
backends. It speaks the Anthropic Messages API on the client side and
translates to the backend's native format (`anthropic`, `oa-compat`/OpenAI
chat-completions, `openai`/Responses, `google`/Gemini) on the upstream side —
with streaming, model discovery, and capability-aware request stripping.

## Features

- **Anthropic Messages API surface** for Claude Code:
  - `POST /v1/messages` (streaming + non-streaming)
  - `POST /v1/messages/count_tokens` (forward or local estimate)
  - `GET /v1/models` (gateway model discovery, alias ids)
- **4 upstream formats** translated through a canonical IR:
  `anthropic`, `oa-compat`, `openai`, `google`.
- **Streaming** with 30 s keep-alive pings, verbatim error passthrough, and
  `message_stop` termination (Claude Code's retry logic works).
- **Model registry** with live discovery (`GET /v1/models` on the backend),
  catalog metadata, and a local cache (`~/.claude-opencode-proxy/models.json`).
- **Capability detection** — strips `thinking`, tools, `cache_control`,
  image blocks, etc. when the model doesn't support them.
- **Retries** on transient network errors / 5xx / 429 (never 4xx).
- **Optional cost pings** (`OPENCODE_EMIT_COST_PINGS=1`).
- **CORS** enabled for browser-based clients.

## Requirements

- Node.js ≥ 20 (LTS 24 recommended)

## Quick start

```bash
npm install
npm run build
npm start
```

The proxy listens on `http://127.0.0.1:8787` by default.

## Configuration

All configuration is via environment variables (see `src/config.ts`).

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `OPENCODE_BACKEND` | auto | `zen` \| `go` \| `free` (auto: go key → go, zen key → zen, else free) |
| `OPENCODE_ZEN_API_KEY` | — | Zen API key (also sent as `x-api-key` upstream) |
| `OPENCODE_GO_API_KEY` | — | Go API key |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | Upstream base URL override |
| `OPENCODE_HOST` | `127.0.0.1` | Listen host |
| `OPENCODE_PORT` | `8787` | Listen port |
| `OPENCODE_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `600000` | Timeout for the upstream response |
| `OPENCODE_MAX_RETRIES` | `2` | Retries on transient 5xx/429/network errors |
| `OPENCODE_MODEL_CACHE_TTL` | `86400` | Seconds between model refreshes |
| `OPENCODE_MODEL_CACHE_FILE` | `~/.claude-opencode-proxy/models.json` | Model cache path |
| `OPENCODE_ENABLE_PROBES` | `false` | Enable `/healthz`/`/ready` probes |
| `OPENCODE_STRIP_UNSUPPORTED` | `true` | Strip unsupported fields per model capability |
| `OPENCODE_EMIT_COST_PINGS` | `false` | Emit cost pings after each stream |

## Using with Claude Code

Point Claude Code at the proxy and give it a credential:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=<opencode-key>   # or ANTHROPIC_API_KEY
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

Optional hardening for strict backends:

```bash
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_THINKING=1        # if the backend rejects `thinking`
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

### Model picker

With `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` and a credential set, the
proxy's `GET /v1/models` populates Claude Code's `/model` picker with
**"From gateway"** rows. Each backend model is exposed under an alias id
(`claude-ocx-<format>--<model>`) with `display_name` set to the real OpenCode
name; the proxy maps the alias back to the real id on inference. Models with a
1M context window get an extra `[1m]` variant row.

Without discovery, you can pin models directly:

```bash
export ANTHROPIC_CUSTOM_MODEL_OPTION=deepseek-v4-flash-free
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='DeepSeek V4 Flash (Free)'
export ANTHROPIC_DEFAULT_SONNET_MODEL=mimo-v2.5-free
```

## Docker

Prebuilt image (published on every merge to `main`):

```bash
docker run --rm -p 8787:8787 \
  -e OPENCODE_BACKEND=zen \
  -e OPENCODE_ZEN_API_KEY=... \
  ghcr.io/schiz0x00/claude-opencode-proxy:latest
```

Or build locally:

```bash
docker build -t claude-opencode-proxy .
docker run --rm -p 8787:8787 \
  -e OPENCODE_BACKEND=zen \
  -e OPENCODE_ZEN_API_KEY=... \
  claude-opencode-proxy
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
```

## Architecture

```
Claude Code ── Anthropic Messages API ──▶ proxy ──▶ OpenCode backend
   (client)     /v1/messages (SSE)          │        /messages | /chat/completions
               /v1/models                   │        /responses | /models/<id>:...
               /v1/messages/count_tokens    │
                                            └─ canonical IR + converters
```

- `src/server.ts` — hono app + minimal `node:http` adapter
- `src/router.ts` — request pipeline (parse → resolve model → strip → translate → fetch → stream)
- `src/translate/` — per-format helpers and canonical-IR converters
- `src/stream.ts` — SSE pump (keep-alive, error passthrough, cost pings)
- `src/modelRegistry.ts` — static + discovered + catalog model metadata
- `src/capability.ts` — capability-aware request stripping

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Branch off `dev`, open
PRs against `dev`; merges to `main` publish the container image.

## License

[MIT](LICENSE)