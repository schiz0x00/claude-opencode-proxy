# claude-opencode-proxy

[![CI](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/ci.yml)
[![Publish container](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/schiz0x00/claude-opencode-proxy/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local proxy that lets **Claude Code** talk to **OpenCode Zen / Go / Free**
backends. It speaks the Anthropic Messages API on the client side and
translates to the backend's native format (`anthropic`, `oa-compat`/OpenAI
chat-completions, `openai`/Responses, `google`/Gemini) on the upstream side —
with streaming, model discovery, reasoning passthrough, and capability-aware
request stripping.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/schiz0x00/claude-opencode-proxy/main/install.sh | bash
```

Then open a new shell and run `claude-oc`.

That single command installs Docker if it is missing, pulls the published
container, starts it on `127.0.0.1:8787`, and adds a `claude-oc` function to
your shell. It is safe to re-run — it upgrades the image and rewrites its own
managed block in your rc files, touching nothing else.

> **Read before piping to a shell.** `curl | bash` executes code from the
> internet as you. Review [`install.sh`](install.sh) first, or download it,
> read it, and run it locally. Docker installation needs `sudo`; the script
> asks before doing that.

With an API key (paid lanes), or to change any default:

```bash
curl -fsSL https://raw.githubusercontent.com/schiz0x00/claude-opencode-proxy/main/install.sh -o install.sh
bash install.sh --zen-key sk-...            # Zen lane
bash install.sh --go-key sk-... --port 9000 # Go lane on another port
bash install.sh --dry-run                   # show what it would do
bash install.sh --uninstall                 # remove container + shell wiring
```

<details>
<summary><b>Installer options</b></summary>

| Flag | Env | Default | Purpose |
| :-- | :-- | :-- | :-- |
| `--port <n>` | `COP_PORT` | `8787` | Host port (bound to `127.0.0.1` only) |
| `--model <id>` | `COP_MODEL` | `deepseek-v4-flash-free` | Default model for `claude-oc` |
| `--backend <b>` | `OPENCODE_BACKEND` | auto | `zen` \| `go` \| `free` |
| `--zen-key <k>` | `OPENCODE_ZEN_API_KEY` | — | Zen key (implies `--backend zen`) |
| `--go-key <k>` | `OPENCODE_GO_API_KEY` | — | Go key (implies `--backend go`) |
| `--image <ref>` | `COP_IMAGE` | `ghcr.io/schiz0x00/claude-opencode-proxy:latest` | Image to run |
| `--container <n>` | `COP_CONTAINER` | `claude-opencode-proxy` | Container name |
| `--skip-docker` | — | — | Never install Docker; fail if absent |
| `--dry-run` | — | — | Print actions, change nothing |
| `--uninstall` | — | — | Remove container, env file, rc blocks |
| `-y`, `--yes` | — | — | No prompts (needed for unattended install) |

</details>

### What the installer changes

- **Container** `claude-opencode-proxy`, `--restart unless-stopped`, published
  to `127.0.0.1:8787` only (never `0.0.0.0` — the proxy has no auth of its own).
- **`~/.claude-opencode-proxy/env.sh`** (mode `600`) with the shell functions.
- **`~/.bashrc`, `~/.bash_profile`, `~/.zshrc`** — whichever exist get a
  three-line block between `# >>> claude-opencode-proxy >>>` markers that
  sources the env file. Both bash and zsh are supported by the same file.

### Shell commands

| Command | Does |
| :-- | :-- |
| `claude-oc` | Claude Code through the proxy (takes all `claude` args, e.g. `claude-oc -p "hi"`) |
| `claude-oc-models` | List models the proxy serves |
| `claude-oc-logs` | Follow container logs |
| `claude-oc-restart` / `-stop` / `-start` | Container control |
| `claude-oc-update` | Pull the latest image and recreate the container |

Override per run: `CLAUDE_OC_MODEL=glm-5-free claude-oc`, or
`CLAUDE_OC_PORT=9000 claude-oc`.

## Manual setup

<details>
<summary><b>Docker without the installer</b></summary>

```bash
docker run -d --name claude-opencode-proxy --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e OPENCODE_BACKEND=zen \
  -e OPENCODE_ZEN_API_KEY=... \
  ghcr.io/schiz0x00/claude-opencode-proxy:latest
```

Build locally instead:

```bash
docker build -t claude-opencode-proxy .
docker run --rm -p 127.0.0.1:8787:8787 claude-opencode-proxy
```

</details>

<details>
<summary><b>From source (Node.js ≥ 20, LTS 24 recommended)</b></summary>

```bash
npm install
npm run build
npm start          # or: npm run dev   (tsx watch)
```

</details>

## Features

- **Anthropic Messages API surface** for Claude Code:
  - `POST /v1/messages` (streaming + non-streaming)
  - `POST /v1/messages/count_tokens` (forward or local estimate)
  - `GET /v1/models` (gateway model discovery, alias ids)
- **4 upstream formats** translated through a canonical IR:
  `anthropic`, `oa-compat`, `openai`, `google`.
- **Streaming** with 30 s keep-alive pings, verbatim error passthrough, and
  `message_stop` termination (Claude Code's retry logic works).
- **Thinking / reasoning passthrough** — upstream `reasoning_content` becomes
  Anthropic `thinking` blocks and is echoed back on the next turn.
- **Reasoning effort** mapped from Claude Code's thinking budget onto whatever
  knob each model actually accepts, read from the upstream catalog.
- **Model registry** with live discovery, catalog metadata, and a local cache
  (`~/.claude-opencode-proxy/models.json`).
- **Capability detection** — strips `thinking`, tools, `cache_control`, image
  blocks, etc. when the model doesn't support them.
- **Retries** on transient network errors / 5xx / 429 (never 4xx).
- **Optional cost pings** (`OPENCODE_EMIT_COST_PINGS=1`).

## Configuration

All configuration is via environment variables (see `src/config.ts`).

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `OPENCODE_BACKEND` | auto | `zen` \| `go` \| `free` (auto: go key → go, zen key → zen, else free) |
| `OPENCODE_ZEN_API_KEY` | — | Zen API key (also sent as `x-api-key` upstream) |
| `OPENCODE_GO_API_KEY` | — | Go API key |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | Upstream base URL override |
| `OPENCODE_HOST` | `127.0.0.1` | Listen host (the container sets `0.0.0.0`) |
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

The installer's `claude-oc` sets all of this for you. To wire it up by hand:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=opencode-free        # any non-empty value on the free lane
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

# Keep background calls (titles, summaries) on a model the proxy serves —
# otherwise they go out as claude-sonnet-* / claude-3-5-haiku and 404.
export ANTHROPIC_MODEL=deepseek-v4-flash-free
export ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-flash-free
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash-free
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash-free
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash-free
export ANTHROPIC_DEFAULT_FABLE_MODEL=deepseek-v4-flash-free

# Claude Code doesn't know these models' context windows and assumes 200k.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000
```

`ANTHROPIC_AUTH_TOKEN` is required **even on the free lane**. Without a
credential Claude Code falls back to its own login and skips gateway model
discovery entirely.

Optional hardening for strict backends:

```bash
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_THINKING=1        # if the backend rejects `thinking`
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

### Model picker

With discovery enabled, `GET /v1/models` populates Claude Code's `/model`
picker with a **"From gateway"** section. Each backend model is exposed under
an alias id (`claude-ocx-<format>--<model>`) with `display_name` set to the
real OpenCode name; the proxy rewrites the alias back to the real id before
forwarding. Models with a 1M context window get an extra `[1m]` row.

Claude's own models still appear alongside the gateway ones — discovery adds a
section, it does not replace the built-in list.

Without discovery, pin models directly:

```bash
export ANTHROPIC_CUSTOM_MODEL_OPTION=deepseek-v4-flash-free
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='DeepSeek V4 Flash (Free)'
```

### Thinking and reasoning effort

Claude Code expresses reasoning effort only as `thinking.budget_tokens`
(`think` ≈ 4k, `megathink` ≈ 10k, `ultrathink` ≈ 32k). Non-Anthropic backends
want a different knob, and which knob varies per model. The proxy reads
`reasoning_options` from the OpenCode catalog and maps the budget onto what
each model actually accepts:

| Catalog advertises | Proxy sends |
| :-- | :-- |
| `budget_tokens` | `thinking.budget_tokens`, clamped to the documented min/max |
| `effort` | `reasoning_effort`, bucketed onto that model's own ladder |
| `toggle` only | `thinking: {type: "enabled"}` |
| nothing | nothing — the field never reaches the backend |

So `deepseek-v4-flash-free` (which advertises `low`/`high`/`max`) receives
`low` / `high` / `max` for the three tiers, while `laguna-s-2.1-free` receives
`low` / `medium` / `high`. `none` and `minimal` are never selected for an
enabled thinking block.

In the other direction, upstream `reasoning_content` is streamed to the client
as Anthropic `thinking` blocks and translated back to `reasoning_content` when
the client echoes it on the next turn — required by providers that reject a
follow-up turn whose assistant message lost its reasoning trace.

## Troubleshooting

<details>
<summary><b><code>404 Unknown model: claude-sonnet-5</code> (or <code>claude-3-5-haiku-*</code>)</b></summary>

Claude Code is making background calls with its built-in model ids, which the
proxy does not serve. Set the `ANTHROPIC_DEFAULT_*_MODEL` and
`ANTHROPIC_SMALL_FAST_MODEL` variables above (`claude-oc` does this already).
Left unset, those calls 404 and get retried, adding latency to every turn.

</details>

<details>
<summary><b><code>401</code> / <code>Model claude-ocx-... is not supported</code></b></summary>

The alias id reached the backend instead of the real model id. Fixed in
current versions — update with `claude-oc-update`.

</details>

<details>
<summary><b>Responses are slow (10–40 s), but fast in the OpenCode TUI</b></summary>

Not the proxy. The **free lane is queued** and has a fat latency tail —
measured directly against the upstream, bypassing the proxy entirely, the same
5-token prompt returns in anywhere from 0.6 s to 23 s, with roughly 40% of
requests landing in a 12–20 s queue. `curl` over HTTP/2 and Node over HTTP/1.1
show the same spread, so it is not a client or transport issue.

The reason it feels worse in Claude Code than in the OpenCode TUI is that one
Claude Code turn is several sequential upstream calls (background work, the
tool loop, then the answer), and each call draws again from that distribution.
The TUI sends one. Three serial draws is where a 40 s turn comes from.

What actually helps: set the `ANTHROPIC_DEFAULT_*`/`SMALL_FAST` vars so no call
is wasted on a 404-and-retry, or use a paid lane with `--zen-key`.

</details>

<details>
<summary><b>The TUI output is jumbled — one word per line</b></summary>

Older versions emitted a separate content block per streamed token. Fixed —
update with `claude-oc-update`.

</details>

<details>
<summary><b><code>parse error near `()'</code> after installing</b></summary>

Your current shell still holds an alias with the same name as one of the
installed functions; zsh expands it while parsing the function definition. The
env file guards against this with `unalias`, but a shell that sourced an older
rc first can still trip. Open a new shell, or run `unalias claude-oc` and
re-source.

</details>

<details>
<summary><b><code>claude.ai connectors are disabled because ANTHROPIC_API_KEY … is set</code></b></summary>

Expected and harmless. Pointing Claude Code at any gateway means the auth
token displaces your claude.ai login for connector purposes.

</details>

<details>
<summary><b><code>"…" is not a model this version of Claude Code recognizes</code></b></summary>

Claude Code doesn't know the context window of third-party models and assumes
200k for auto-compact. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the real window
(`claude-oc` sets 200000, which is correct for `deepseek-v4-flash-free`), or
append `[1m]` to the model name for 1M-context models.

</details>

<details>
<summary><b>Docker permission denied after install</b></summary>

The installer adds you to the `docker` group, which only takes effect on your
next login. Log out and back in, or use `newgrp docker` in the current shell.

</details>

## Privacy

The **free lane retains prompts** and may use them to improve models — the
proxy logs a warning about this at startup. Do not send confidential data
through `OPENCODE_BACKEND=free`. Paid lanes (`zen`, `go`) follow OpenCode's
own terms.

The proxy binds to `127.0.0.1` and has no authentication of its own; anything
that can reach the port can use your key. Do not expose it publicly.

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
- `src/capability.ts` — capability stripping and reasoning-effort mapping

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
```

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Branch off `dev`, open
PRs against `dev`; merges to `main` publish the container image.

## License

[MIT](LICENSE)
