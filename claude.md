# Claude Code & Anthropic SDK — How They Work

Research notes for building a proxy that sits between **Claude Code** and an
Anthropic-compatible backend (e.g. OpenCode Zen's `/v1/messages` endpoint).

Sources: `@anthropic-ai/sdk` source (`anthropics/anthropic-sdk-typescript`),
`anthropic` Python SDK, Claude Code docs (`code.claude.com/docs`:
env-vars, llm-gateway-protocol, model-config), `1rgs/claude-code-proxy`
(reference proxy implementation), `anthropics/claude-code` repo.

---

## 1. The Anthropic SDK (TypeScript `@anthropic-ai/sdk`)

The SDK is a thin, Stainless-generated HTTP client. Everything it does is a
plain REST call you can replicate with `curl`/`fetch`.

### 1.1 Client construction

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'], // -> `X-Api-Key` header
  // authToken: '...',                       // -> `Authorization: Bearer <t>` header (alternative)
  baseURL: process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
  timeout: 600_000,        // default 10 min
  maxRetries: 2,           // default 2
  defaultHeaders: { 'X-Custom': '1' },
  // fetch, fetchOptions, dangerouslyAllowBrowser, withOptions() clones
});
```

Key facts (verified in `src/client.ts`):

| Option | Env var | Effect |
| :-- | :-- | :-- |
| `baseURL` | `ANTHROPIC_BASE_URL` | Default `https://api.anthropic.com` (no `/v1` suffix; SDK appends paths) |
| `apiKey` | `ANTHROPIC_API_KEY` | Sends `X-Api-Key: <key>` |
| `authToken` | `ANTHROPIC_AUTH_TOKEN` | Sends `Authorization: Bearer <token>` |
| `timeout` | — | `600000` ms (10 min) |
| `maxRetries` | — | `2` |
| `defaultHeaders` | `ANTHROPIC_CUSTOM_HEADERS` (parsed `Name: Value` lines) | merged into every request |

Headers the SDK always adds:
- `anthropic-version: 2023-06-01`
- `User-Agent: Anthropic/JS <version>`
- `X-Stainless-Retry-Count`, `X-Stainless-Timeout`, platform headers
- `Accept: application/json`

Auth precedence: `apiKey` → `X-Api-Key`; `authToken` → `Authorization: Bearer`.
Both can be set; a gateway sees whichever the client was configured with.

### 1.2 Resources / endpoints

| Call | HTTP |
| :-- | :-- |
| `client.messages.create({...})` | `POST /v1/messages` |
| `client.messages.stream({...})` | `POST /v1/messages` (SSE) |
| `client.messages.create({stream:true})` | `POST /v1/messages` (SSE, low-mem iterable) |
| `client.messages.countTokens({...})` | `POST /v1/messages/count_tokens` |
| `client.models.list()` | `GET /v1/models` |
| `client.beta.messages.*` | `POST /v1/messages?beta=true` |

`messages.stream()` returns a `MessageStream` (EventEmitter + async iterator)
with `.on('text'|'streamEvent'|'message'|'error'|'end')`, `.finalMessage()`,
`.finalText()`, `.abort()`, `.done()`.

### 1.3 Messages request body (the contract a proxy must accept)

```jsonc
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 32000,
  "stream": true,
  "system": [
    { "type": "text", "text": "<system prompt>",
      "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    { "role": "user", "content": [
        { "type": "text", "text": "hello" } ] },
    { "role": "assistant", "content": [
        { "type": "text", "text": "hi" },
        { "type": "tool_use", "id": "toolu_01...", "name": "Bash",
          "input": { "command": "ls" } } ] },
    { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_01...",
          "content": "file1 file2" } ] }
  ],
  "tools": [
    { "name": "Bash", "description": "...",
      "input_schema": { "type": "object", "properties": {} },
      "cache_control": { "type": "ephemeral" } }
  ],
  "tool_choice": { "type": "auto" },
  "thinking": { "type": "enabled", "budget_tokens": 1024 },
  "temperature": 1,
  "top_p": 0.9,
  "stop_sequences": [],
  "metadata": { "user_id": "..." }
}
```

Content block types: `text`, `image`, `tool_use`, `tool_result`, `thinking`,
`redacted_thinking`. `system` may be a plain string or an array of blocks.

### 1.4 Streaming response (SSE events)

Claude Code consumes these verbatim. A proxy must emit them in this shape:

| Event | Payload highlights |
| :-- | :-- |
| `message_start` | `message` skeleton (`id`, `model`, `role:"assistant"`, `content:[]`, `stop_reason:null`, `usage`) |
| `content_block_start` | `index`, `content_block` (`type:"text"|"tool_use"|"thinking"`) |
| `content_block_delta` | `index`, `delta`: `text_delta{text}` / `input_json_delta{partial_json}` / `thinking_delta{thinking, signature}` / `signature_delta{signature}` |
| `content_block_stop` | `index` |
| `message_delta` | `delta:{stop_reason, stop_sequence}`, `usage:{output_tokens}` |
| `message_stop` | — |
| `ping` | keep-alive (must be forwarded) |
| `error` | error object |
| `data: [DONE]` | terminal marker |

`stop_reason` ∈ `end_turn | max_tokens | stop_sequence | tool_use | pause_turn`.

### 1.5 Python SDK (`anthropic`)

```python
from anthropic import Anthropic

client = Anthropic(
    api_key=os.environ.get("ANTHROPIC_API_KEY"),
    base_url="https://api.anthropic.com",   # note: base_url (underscore)
    auth_token=None,                        # -> Authorization: Bearer
    timeout=600.0,
    max_retries=2,
    default_headers={},
)

msg = client.messages.create(model="claude-sonnet-4-6", max_tokens=1024,
                             messages=[{"role": "user", "content": "Hi"}])

with client.messages.stream(...) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

Async twin: `AsyncAnthropic` with `await client.messages.create(...)` and
`async with client.messages.stream(...)`. Same wire format as TS SDK.

---

## 2. How Claude Code works

### 2.1 What it is

- npm package **`@anthropic-ai/claude-code`**, binary **`claude`**.
- Node.js CLI (bundled/minified; `cli.js` + `vendor/`), TUI + headless (`-p`).
- Agentic coding agent: Bash, file read/write/edit, grep/glob, web, MCP tools.
- Talks to the **Anthropic Messages API** (or a gateway via `ANTHROPIC_BASE_URL`).

### 2.2 How it calls the API

- **Always streams**: `POST {base}/v1/messages` with `stream: true`.
- Optional `POST /v1/messages/count_tokens` (falls back to local estimate if absent).
- Optional `GET /v1/models?limit=1000` for gateway model discovery (opt-in).
- Inference requests post to `/v1/messages?beta=true` — **match on path, not full URL**.

Request headers Claude Code sends:

| Header | Notes |
| :-- | :-- |
| `Authorization: Bearer <t>` | from `ANTHROPIC_AUTH_TOKEN` |
| `x-api-key: <key>` | from `ANTHROPIC_API_KEY` (may send both) |
| `anthropic-version` | `2023-06-01` — forward unchanged |
| `anthropic-beta` | comma-separated capability values — **forward verbatim, don't allowlist** |
| `x-claude-code-session-id` | aggregate requests per session |
| `x-claude-code-agent-id` | subagent that issued the request |
| `x-claude-code-parent-agent-id` | nested-agent parent |
| `anthropic-workspace-id` | only for Claude Platform on AWS |
| custom | from `ANTHROPIC_CUSTOM_HEADERS` |

Body fields Claude Code sends (beyond the base Messages shape):
`thinking` (incl. `{"type":"adaptive"}` on 4.6+), `context_management`,
`output_config` (effort/structured output), beta tool fields (`strict`,
`defer_loading`, `eager_input_streaming`), `cache_control` on system/tools.

### 2.3 System prompt attribution block

Claude Code prepends a short attribution block (client version + prompt
fingerprint) as the **first entry of the `system` array**. `api.anthropic.com`
strips it positionally; any other upstream receives it as part of the prompt.

Proxy implications:
- Forward the `system` array **unchanged**, block first, in its own array entry.
- If you must reshape system content, tell the client to omit it:
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.

### 2.4 Streaming requirements (gateway contract)

- **Must stream.** Buffering the full response stalls Claude Code.
- **Forward keep-alive `ping` events.** Claude Code counts every byte relayed
  and aborts a stream silent for 300 s (byte-level watchdog) on
  `ANTHROPIC_BASE_URL` connections. Pings are the only traffic during long
  thinking pauses.
- **Forward error bodies unmodified.** Claude Code's automatic retry/feature
  disable matches on upstream error wording; wrapping errors in a new envelope
  breaks recovery.
- Non-streaming fallback exists but can duplicate tool execution behind a proxy
  (`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` disables it).

### 2.5 Feature pass-through (what breaks if stripped)

| Feature | Header+body pair | If broken |
| :-- | :-- | :-- |
| Context management | beta header + `context_management` field | `400 Extra inputs are not permitted` |
| Extended context / interleaved thinking | beta headers only | silently unavailable |
| Beta tool fields | beta header + `strict`/`defer_loading` | `400` naming the field |
| Effort / structured outputs | beta header + `output_config` | `400 Extra inputs are not permitted` |
| Adaptive reasoning | no header; `thinking:{"type":"adaptive"}` | `400` naming `thinking` |
| Token counting | `count_tokens` endpoint | local estimate fallback |

Escape hatch for strict backends: **`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`**
strips Anthropic-specific beta headers and beta tool-schema fields (keeps
`name`, `description`, `input_schema`, `cache_control`).

### 2.6 Model discovery (gateway `/v1/models`)

- **Opt-in since v2.1.129**: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
  (was automatic in v2.1.126–2.1.128). Off by default.
- `GET /v1/models?limit=1000`, 3s timeout, redirects treated as failure.
- **Credential-gated**: the fetch fires only when `ANTHROPIC_AUTH_TOKEN` or a
  resolved API key (incl. `apiKeyHelper`) is present. A claude.ai OAuth login
  with no credential → discovery never runs (waired-ai/waired-agent#332).
- Sends exactly **one** credential header: `Authorization: Bearer` (if
  `ANTHROPIC_AUTH_TOKEN`) else `x-api-key`.
- Reads `id` + optional `display_name`; **keeps an entry only when its `id`
  contains `claude` or `anthropic` (case-insensitive, matched anywhere)**.
  Before v2.1.223 the match was "starts with". Provider-prefixed ids like
  `vertex_ai/claude-sonnet-4-6` pass; `deepseek-v4-flash-free` does not.
- Picker rows are labeled **"From gateway"** and use `display_name` as the label.
- Cached to `~/.claude/cache/gateway-models.json` (or under `CLAUDE_CONFIG_DIR`),
  refreshed each startup; on fetch failure the picker falls back to the cached
  list, then the built-in list. The **cache read applies the same
  `claude`/`anthropic` filter** (verified 2.1.220), so raw foreign ids can't be
  smuggled in via the cache either.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set to **any** value (even `"0"`)
  also blocks discovery and hides cached entries (claude-code#61112).

### 2.7 Key env vars for proxy/gateway use

| Variable | Purpose |
| :-- | :-- |
| `ANTHROPIC_BASE_URL` | **Route Claude Code to your proxy** (Anthropic Messages format) |
| `ANTHROPIC_API_KEY` | sent as `x-api-key` |
| `ANTHROPIC_AUTH_TOKEN` | sent as `Authorization: Bearer` |
| `ANTHROPIC_CUSTOM_HEADERS` | extra headers (`Name: Value`, newline-separated) |
| `ANTHROPIC_BETAS` | extra `anthropic-beta` values |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` etc. | model aliases |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | default `32000` for unrecognized model IDs |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | override assumed context window |
| `MAX_THINKING_TOKENS` | thinking budget; `0` disables thinking |
| `CLAUDE_CODE_DISABLE_THINKING` | omit `thinking` param entirely |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | strip beta headers/fields |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | populate `/model` from gateway `/v1/models` |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | omit system-prompt attribution block |
| `CLAUDE_CODE_EXTRA_BODY` | JSON merged into every request body |
| `API_TIMEOUT_MS` | request timeout (default 600000) |
| `CLAUDE_CODE_MAX_RETRIES` | retry count (default 10) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | kill telemetry/updates/discovery |
| `DISABLE_TELEMETRY` / `DO_NOT_TRACK` | telemetry opt-out |
| `CLAUDE_CONFIG_DIR` | config dir (default `~/.claude`) |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` | stream tool inputs (off by default behind custom base URL) |

### 2.8 Config files

- `~/.claude/settings.json` (user), `.claude/settings.json` (project, checked in),
  `.claude/settings.local.json` (project-local, gitignored), managed settings.
- `env` key inside settings files sets env vars for every launch.
- `claude --model <id>`, `/model` in-session; `claude -p` headless;
  `--output-format stream-json`; `--debug` logs to `~/.claude/debug/<session-id>.txt`.

### 2.9 Tools Claude Code exposes to the model

`Bash`, `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `Task`/`TodoWrite`, `TaskCreate/Update/Get/List`, subagents
(`Agent`/`Task`), `Skill`, `AskUserQuestion`, `PushNotification`, plus MCP
servers (stdio/HTTP/SSE). Tool schemas carry `cache_control` and beta fields.

### 2.10 Showing non-Anthropic models in the `/model` picker

The picker filter (`id` must contain `claude`/`anthropic`) is the hard
constraint on what discovery can surface. Three ways to get real OpenCode Zen
model names selectable:

**A. Manual env vars (no proxy changes; raw OpenCode id shown in picker)**

- `ANTHROPIC_CUSTOM_MODEL_OPTION=<id>` — one entry, any string, no validation;
  optional `_NAME`/`_DESCRIPTION` label it. Appears at the bottom of the picker.
- `ANTHROPIC_DEFAULT_SONNET_MODEL=<id>` (+ `OPUS`/`HAIKU`/`FABLE`) — up to four
  more, shown on the built-in alias rows; `_NAME`/`_DESCRIPTION` relabel them.
- Total: **5 real OpenCode ids** (1 custom + 4 aliases). Example:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_AUTH_TOKEN=<opencode-key>
export ANTHROPIC_CUSTOM_MODEL_OPTION=deepseek-v4-flash-free
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='DeepSeek V4 Flash (Free)'
export ANTHROPIC_DEFAULT_SONNET_MODEL=mimo-v2.5-free
export ANTHROPIC_DEFAULT_OPUS_MODEL=big-pickle
```

**B. Proxy-served `/v1/models` with alias ids (unlimited; "From gateway" rows)**

- The proxy serves `GET /v1/models` (Anthropic-native shape) with ids that pass
  the filter, e.g. `claude-ocx-<provider>--<model>`, and `display_name` set to
  the real OpenCode name. The picker shows the display name; the proxy maps the
  alias back to the real Zen id on inference. Reference impl: `lidge-jun/opencodex`
  (`claude-ocx-native--gpt-5.6-sol` → label `gemini-3-pro (gemini)`).
- Requires `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` **and** a credential
  (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`), or the fetch never fires.
- A `[1m]` suffix on an id adds a context-variant picker row; the proxy strips
  it before routing (also outranks `CLAUDE_CODE_MAX_CONTEXT_TOKENS`).

**C. Pre-seed `~/.claude/cache/gateway-models.json` (when discovery can't run)**

- Schema (verified against 2.1.220): `{"baseUrl", "fetchedAt", "models":[{id, display_name}]}`
  — `fetchedAt` is epoch **milliseconds** (a number); `baseUrl` must byte-equal
  the live `ANTHROPIC_BASE_URL`; the reader strips unknown fields and **still
  applies the `claude`/`anthropic` filter**, so only alias ids work here too.
  Mode 0600.
- Useful for credential-less (OAuth) setups where discovery never fires; the
  picker reads whatever cache exists (falls back to cache when fetch fails).

Gotchas: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (any value) hides everything;
`_SUPPORTED_CAPABILITIES` is inert behind `ANTHROPIC_BASE_URL` — use
`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for effort on custom model ids.

---

## 3. Implications for `claude-opencode-proxy`

1. **Claude Code is the client.** Point it at the proxy with
   `ANTHROPIC_BASE_URL=http://localhost:<port>` + `ANTHROPIC_AUTH_TOKEN` (or
   `ANTHROPIC_API_KEY`). It will POST Anthropic-format requests to
   `/v1/messages` (and optionally `/v1/messages/count_tokens`, `/v1/models`).
2. **The proxy must speak Anthropic Messages on the client side** and translate
   to OpenCode Zen's endpoint format (see `endpoint.md`): `oa-compat`
   `/v1/chat/completions`, `openai` `/v1/responses`, `anthropic` `/v1/messages`,
   `google` `/v1/models/<id>`.
3. **Streaming is mandatory** — translate SSE events, keep `ping` alive, and
   forward errors unmodified so Claude Code's retry logic works.
4. **Beta headers/fields will arrive.** Either forward them to a backend that
   accepts them, or instruct users to set
   `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (and `CLAUDE_CODE_DISABLE_THINKING=1`
   if the backend rejects `thinking`).
5. **Model routing**: Claude Code sends a `model` field (e.g. `claude-sonnet-4-6`
   or a custom alias). The proxy maps it to an OpenCode Zen model id and picks
   the right endpoint format per model (see `endpoint.md` discovery section).
6. **Free models** (anonymous, `oa-compat` → `/v1/chat/completions`) are the
   cheapest path; Claude Code just needs the model id in the request body.
7. **Attribution block**: keep the `system` array unchanged, or set
   `CLAUDE_CODE_ATTRIBUTION_HEADER=0` on the client.
8. **Model picker**: serve `GET /v1/models` (Anthropic-native shape) so
   `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` populates `/model`. Because
   ids must contain `claude`/`anthropic`, expose each Zen model under a
   reversible alias (`claude-...`) with `display_name` = real OpenCode name, and
   map the alias back to the Zen id on `/v1/messages` (see §2.10). For a
   bare-minimum setup without discovery, point users at
   `ANTHROPIC_CUSTOM_MODEL_OPTION` + `ANTHROPIC_DEFAULT_*_MODEL` (5 slots max,
   real ids shown).