# claude-opencode-proxy — Implementation Plan

A lightweight HTTP proxy that lets **Claude Code** talk to **OpenCode services**
(Zen, Go, and the anonymous Free tier) transparently. Claude Code speaks the
Anthropic Messages API; OpenCode exposes four different wire formats. This
proxy presents a single Anthropic-compatible endpoint to Claude Code and
translates to the correct OpenCode endpoint per model.

This plan is the result of a research-only phase. It is written to be
self-sufficient: implementation can begin immediately without further
architectural decisions. Companion research docs: `claude.md` (Claude Code
client contract) and `endpoint.md` (OpenCode Zen/Go endpoints & formats).

---

## 1. Overview & Goals

### 1.1 What it does

```
┌─────────────┐   Anthropic Messages   ┌──────────────────────┐   OpenCode wire format   ┌──────────────────┐
│ Claude Code │ ─────────────────────▶ │  claude-opencode-    │ ──────────────────────▶  │  OpenCode Zen /  │
│ (client)    │ ◀───────────────────── │  proxy               │ ◀──────────────────────  │  Go / Free       │
└─────────────┘   SSE (Anthropic)      └──────────────────────┘   (per-model format)     └──────────────────┘
```

- **Client side (facing Claude Code):** one Anthropic-compatible surface —
  `POST /v1/messages` (streaming), `POST /v1/messages/count_tokens`,
  `GET /v1/models`. Claude Code is pointed at it with `ANTHROPIC_BASE_URL`.
- **Backend side (facing OpenCode):** the proxy selects one of the four
  OpenCode formats per model and translates the request/response/stream.

### 1.2 Goals

1. **Transparent.** Claude Code behaves exactly as if talking to
   `api.anthropic.com`: streaming works, tool calls work, retries work, the
   `/model` picker shows real OpenCode model names.
2. **Correct by construction.** Translation mirrors the proven
   `anomalyco/opencode` gateway (`packages/console/app/src/routes/zen/util/`)
   rather than reinventing semantics. Lossless conversions, usage
   normalization, stream chunk mapping, and error passthrough.
3. **Backend-aware.** Auto-detect which OpenCode backend is configured and
   expose **only** the models that backend actually serves. Claude Code must
   never see a model that will 404/401 at runtime.
4. **Lightweight.** Single binary / single process, no database, no external
   services. Env-var configured.

### 1.3 Non-goals

- No billing, quotas, or multi-tenant auth (the proxy uses the user's own
  OpenCode key; OpenCode enforces limits).
- No caching of model responses.
- No UI. No persistence beyond an optional model-discovery cache file.
- Not a general-purpose gateway: only Claude Code → OpenCode.

---

## 2. Backend Detection

### 2.1 Semantics (from the spec, verbatim intent)

| Configuration | Exposed models | Backend base URL |
| :-- | :-- | :-- |
| No API key configured | **Free tier only** (`oa-compat` → `/v1/chat/completions`) | `https://opencode.ai/zen/v1` |
| Zen API key configured | **Zen models only** | `https://opencode.ai/zen/v1` |
| Go API key configured | **Go models only** | `https://opencode.ai/zen/go/v1` |

- **Auto-detection is the default.** If no explicit backend override is set,
  the proxy infers the backend from which env vars are present.
- **Never mix.** When a Zen key is configured, hide every non-Zen model
  (including free and Go). When a Go key is configured, hide everything else.
  When no key is configured, expose only the free models.
- The free tier is anonymous (no key) and lives on the Zen base URL, so
  "no key" and "Zen key" share a base URL but expose disjoint model sets.

### 2.2 Detection precedence

1. Explicit override env var `OPENCODE_BACKEND` (`zen` | `go` | `free`) wins.
2. Else if `OPENCODE_GO_API_KEY` is set → `go`.
3. Else if `OPENCODE_ZEN_API_KEY` is set → `zen`.
4. Else → `free`.

Rationale: a user who sets both keys explicitly chooses with the override;
otherwise Go wins over Zen because Go is the more constrained (paid, limited)
tier and the user is more likely to intend it. Documented in README.

### 2.3 Key handling

- The proxy accepts the OpenCode key from Claude Code in **either** header
  (`x-api-key` or `Authorization: Bearer`), because Claude Code may be
  configured with `ANTHROPIC_API_KEY` (→ `x-api-key`) or
  `ANTHROPIC_AUTH_TOKEN` (→ `Authorization: Bearer`).
- The proxy then re-emits the key to OpenCode in the **format-correct**
  header: `x-api-key` for `anthropic`/`google` formats, `Authorization: Bearer`
  for `oa-compat`/`openai` formats.
- If the backend is `free` (no key), the proxy does **not** require a key from
  Claude Code and sends no auth header upstream.

---

## 3. Architecture & Modules

Single Node.js process (TypeScript, `node:http` or a minimal framework like
`hono`/`fastify` — no heavy framework needed). Modules:

```
src/
  config.ts            # env parsing, backend detection, typed Config
  server.ts            # HTTP server, routing, CORS, health
  backend.ts           # backend resolution (zen | go | free) + base URL
  modelRegistry.ts     # model list per backend + alias mapping + metadata
  capability.ts        # capability detection (dynamic + fallback registry)
  router.ts            # request router: model → format → provider helper
  translate/
    types.ts           # CommonRequest / CommonResponse / CommonChunk / UsageInfo
    provider.ts        # ProviderHelper interface + converter factories
    anthropic.ts       # from/to Anthropic Messages
    openai-compat.ts   # from/to oa-compat (chat/completions)
    openai.ts          # from/to OpenAI Responses
    google.ts          # from/to Gemini generateContent
  stream.ts            # SSE pump: read upstream, translate, re-emit; ping/keepalive
  errors.ts            # error classes + Anthropic error envelope
  auth.ts              # key extraction + per-format header injection
  logging.ts           # leveled logger (debug/info/warn/error)
  health.ts            # GET /healthz, GET / (info)
```

### 3.1 Request flow (POST /v1/messages)

1. **Parse** body (Anthropic Messages shape) + headers.
2. **Resolve model** — map the requested model id (Claude Code may send an
   alias like `claude-ocx-...` or a real id) to a registry entry.
3. **Resolve backend** — from config (see §2).
4. **Select provider** — registry entry carries `format`; pick the matching
   `ProviderHelper`.
5. **Translate request** — `createBodyConverter("anthropic", format)`.
6. **Inject auth** — `modifyHeaders` with the correct header for `format`.
7. **Forward** — POST to the format's URL on the backend base.
8. **Respond** —
   - non-stream: `createResponseConverter(format, "anthropic")` → JSON.
   - stream: pipe upstream SSE through `createStreamPartConverter(format,
     "anthropic")`, keep `ping` alive, forward errors verbatim, append
     `data: [DONE]`.

### 3.2 Other endpoints

- `POST /v1/messages/count_tokens` — forward to the backend's
  `/v1/messages/count_tokens` if the backend is `anthropic`-format capable;
  otherwise return a local token estimate (see §8.4). Claude Code falls back
  to a local estimate if this endpoint is absent, so it is optional.
- `GET /v1/models` — serve the registry for the active backend, in
  Anthropic-native shape with alias ids (see §6).
- `GET /healthz`, `GET /ready` — liveness/readiness.
- `OPTIONS *` — CORS preflight (Claude Code doesn't need it, but harmless).

---

## 4. Provider Abstraction Strategy

Mirror the reference implementation's `ProviderHelper` pattern exactly. This
is the single most important architectural decision: **one plugin per wire
format, no large conditionals in the request path.**

### 4.1 The `ProviderHelper` interface

```ts
type Format = "anthropic" | "google" | "openai" | "oa-compat";

interface ProviderHelper {
  format: Format;
  modifyUrl: (providerApi: string, isStream?: boolean) => string;
  modifyHeaders: (headers: Headers, apiKey: string, stickyId: string) => void;
  modifyBody: (body: Record<string, any>) => Record<string, any>;
  createBinaryStreamDecoder: () => ((chunk: Uint8Array) => Uint8Array | undefined) | undefined;
  createUsageParser: () => { parse: (chunk: string) => void; retrieve: () => any };
  extractUsage: (response: any) => any;
  normalizeUsage: (usage: any) => UsageInfo;
}
```

### 4.2 The Common intermediate representation

All formats convert **to and from** a single canonical shape (OpenAI
chat-completion-like), so any format can translate to any other by composing
two converters. This is exactly what the reference does with
`createBodyConverter` / `createResponseConverter` / `createStreamPartConverter`.

```ts
interface CommonRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  messages: CommonMessage[];   // role: system|user|assistant|tool
  stream: boolean;
  tools?: CommonTool[];
  tool_choice?: unknown;
}

interface CommonResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{
    index: number;
    message: { role: "assistant"; content?: string; tool_calls?: CommonToolCall[] };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number } };
}

interface CommonChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [{
    index: number;
    delta: { role?: "assistant"; content?: string; tool_calls?: CommonToolCall[] };
    finish_reason: ... | null;
  }];
  usage?: ...;
}

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}
```

### 4.3 Converter factories

```ts
createBodyConverter(from: Format, to: Format): (body: any) => any
createResponseConverter(from: Format, to: Format): (resp: any) => any
createStreamPartConverter(from: Format, to: Format): (part: string) => string
```

Each factory: if `from === to`, return the input unchanged (passthrough).
Otherwise `from<Format>X(...)` → canonical → `to<Format>X(...)`. Stream
converters return the input string unchanged when a chunk is not parseable
(error/keep-alive passthrough).

### 4.4 Per-format helper table (from the reference source)

| Format | URL suffix | Auth header | Notes |
| :-- | :-- | :-- | :-- |
| `anthropic` | `/messages` | `x-api-key` | also sets `anthropic-version: 2023-06-01`; adds `anthropic-beta: context-1m-2025-08-07` when model id contains `sonnet` or `opus-4-6` |
| `oa-compat` | `/chat/completions` | `Authorization: Bearer` | adds `stream_options: { include_usage: true }` when streaming |
| `openai` | `/responses` | `Authorization: Bearer` | |
| `google` | `/models/<id>:streamGenerateContent?alt=sse` (stream) or `:generateContent` | `x-goog-api-key` | model id embedded in URL |

> **Reference caveat (verified):** the reference's `createBodyConverter` has
> egress branches for `anthropic`, `openai`, and `oa-compat` but **none for
> `google`** (anomalyco/opencode#39696). Cross-family `gemini-*` requests via
> `/chat/completions`, `/messages`, or `/responses` forward a body with no
> `contents` key and fail. Only the native `/v1/models/<id>` endpoint works.
> The proxy must implement the google↔canonical converters itself (they cannot
> be copied from the reference) and should route gemini models to the native
> google endpoint.

### 4.5 Why this pattern

- **Composable:** adding a new backend format = one new plugin file + one
  registry entry. No changes to the router.
- **Testable:** each `from`/`to` pair is a pure function; unit tests can
  round-trip fixtures without a network.
- **Proven:** this is the exact architecture the OpenCode Zen gateway uses in
  production for the same translation problem.

---

## 5. API Translation Strategy

Claude Code always sends Anthropic Messages. The proxy translates to the
model's format. Details below are the exact mappings from the reference
implementation.

### 5.1 Anthropic → canonical (`fromAnthropicRequest`)

- `system` (string or array of `{type:"text",text}` blocks) → one or more
  `{role:"system", content}` messages (skip empty).
- `messages[].content` blocks:
  - `text` → `{type:"text", text}` (kept as part)
  - `image` → `{type:"image_url", image_url:{url}}` (from `source.url` or
    `source.base64` + `media_type`)
  - `tool_use` → assistant message with `tool_calls:[{id, type:"function",
    function:{name, arguments: JSON.stringify(input)}}]`
  - `tool_result` → `{role:"tool", tool_call_id, content}`
- `max_tokens`, `temperature`, `top_p`, `stop_sequences` → `stop`,
  `stream`, `tools` (Anthropic `{name, description, input_schema}` →
  OpenAI `{type:"function", function:{name, description, parameters}}`),
  `tool_choice`.

### 5.2 canonical → Anthropic (`toAnthropicRequest`)

- `system` messages → `system` array of `{type:"text", text}` blocks; add
  `cache_control:{type:"ephemeral"}` to the first **4** system blocks (the
  reference caps at 4).
- user content parts → `text` / `image` blocks; assistant `content` +
  `tool_calls` → `text` + `tool_use` blocks; `role:"tool"` → `tool_result`
  blocks with `tool_use_id`.
- `tools` → `{name, description, input_schema}`.

### 5.3 Anthropic → canonical response (`fromAnthropicResponse`)

- `id` `msg_*` → `chatcmpl_*`.
- `content` blocks → `message.content` (joined text) + `message.tool_calls`
  (from `tool_use` blocks, `input` JSON-stringified).
- `stop_reason` mapping: `end_turn`→`stop`, `tool_use`→`tool_calls`,
  `max_tokens`→`length`, `content_filter`→`content_filter`.
- `usage` → `{prompt_tokens: input_tokens, completion_tokens: output_tokens,
  total_tokens, prompt_tokens_details:{cached_tokens: cache_read_input_tokens}}`.

### 5.4 canonical → Anthropic response (`toAnthropicResponse`)

- `message.content` + `message.tool_calls` → `content` blocks (`text` +
  `tool_use` with `input` JSON-parsed, fallback to raw string).
- `finish_reason` → `stop_reason` (inverse of above).
- `usage` → `input_tokens`, `output_tokens`, `cache_read_input_tokens`.

### 5.5 Streaming chunk mapping (the critical path)

**Anthropic SSE** (two lines per event: `event: <type>\n` + `data: <json>`):

| Anthropic event | canonical chunk |
| :-- | :-- |
| `content_block_start` (text) | `delta.content` (empty) |
| `content_block_delta` `text_delta` | `delta.content` |
| `content_block_start` (tool_use) | `delta.tool_calls[0]` with `function.name` |
| `content_block_delta` `input_json_delta` | `delta.tool_calls[0].function.arguments` |
| `message_delta` | `finish_reason` (stop_reason mapped) |
| `message_start` / `message_stop` / `ping` | passthrough (no canonical chunk) |

**canonical → Anthropic SSE** (inverse):

| canonical | Anthropic event |
|---|---|
| `delta.content` | `content_block_delta` `text_delta` |
| `delta.tool_calls[].function.name` | `content_block_start` `tool_use` |
| `delta.tool_calls[].function.arguments` | `content_block_delta` `input_json_delta` |
| `finish_reason` | `message_delta` `{stop_reason, stop_sequence:null}` |
| `usage` | `message_delta` `usage` |

**oa-compat SSE** (`data: {...}` lines): `delta.content`, `delta.tool_calls`
(with `index`), `finish_reason`, and a final usage-bearing chunk
(`stream_options.include_usage`). `data: [DONE]` is the terminal marker.

**openai (Responses) SSE** (`event: X` + `data: {...}`):
`response.output_text.delta` → text; `response.output_item.added`
(function_call) → tool name; `response.function_call_arguments.delta` →
tool args; `response.completed` → finish_reason + usage.

**google SSE** (`data: {...}` lines): `candidates[0].content.parts[].text`,
`functionCall` parts, `finishReason`, `usageMetadata`.

### 5.6 Usage normalization (per format → `UsageInfo`)

| Format | inputTokens | outputTokens | reasoning | cacheRead | cacheWrite5m |
|---|---|---|---|---|---|
| anthropic | `input_tokens` | `output_tokens` | — | `cache_read_input_tokens` | `cache_creation.ephemeral_5m_input_tokens` ?? `cache_creation_input_tokens` |
| oa-compat | `prompt_tokens - cached` | `completion_tokens` | `completion_tokens_details.reasoning_tokens` | `cached_tokens` (moonshot) ?? `prompt_tokens_details.cached_tokens`; if `adjustCacheUsage` and none, estimate `floor(input*0.9)` | `prompt_tokens_details.cache_creation_input_tokens` |
| openai | `input_tokens - cached` | `output_tokens` | `output_tokens_details.reasoning_tokens` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` |
| google | `promptTokenCount - cachedContentTokenCount` | `candidatesTokenCount` | `thoughtsTokenCount` | `cachedContentTokenCount` | — |

### 5.7 Error translation

- **Forward upstream error bodies unmodified** (Claude Code's retry /
  feature-disable logic matches on upstream wording). Do **not** wrap errors in
  a new envelope.
- When the proxy itself must produce an error, use the Anthropic error shape
  that the `@ai-sdk/anthropic` client renders: both top-level `type` and
  `error.type` set:
  ```json
  { "type": "error", "error": { "type": "error", "message": "..." } }
  ```
- Status codes: 401 auth, 403 region/forbidden, 429 rate/usage limits (with
  `retry-after` when known), 404 unknown model, 500 internal.
- Map OpenCode limit errors to 429 with a clear message (e.g. Go usage limit,
  free usage limit, monthly limit) so Claude Code surfaces them and stops
  retrying.

---

## 6. Model Registry & Discovery

### 6.1 Backend model sets (from research)

**Zen** (`https://opencode.ai/zen/v1`, 61 models) — the four format families:

| Format | Models |
| :-- | :-- |
| `anthropic` (`/v1/messages`) | `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus` |
| `openai` (`/v1/responses`) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5`, `gpt-5-codex`, `gpt-5-nano`, `grok-4.5`, `grok-build-0.1` |
| `oa-compat` (`/v1/chat/completions`) | `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5` |
| `google` (`/v1/models/<id>`) | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash` |

**Go** (`https://opencode.ai/zen/go/v1`): the docs table lists **19 models**;
the live `/v1/models` endpoint returns **25** — the 6 extra
(`kimi-k2.5`, `glm-5`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`,
`hy3-preview`) are undocumented, so their formats must be probed at runtime
(see §6.3):
`/chat/completions`: `grok-4.5`, `glm-5.2`, `glm-5.1`, `kimi-k3`,
`kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`,
`mimo-v2.5`, `mimo-v2.5-pro`, `hy3`; `/responses`: `gpt-5.6-luna`;
`/messages`: `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `qwen3.8-max`,
`qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`.

**Free** (Zen base, anonymous, all `oa-compat`): `big-pickle`,
`deepseek-v4-flash-free`, `mimo-v2.5-free`, `laguna-s-2.1-free`,
`ling-3.0-tiny-free`, `ling-3.0-flash-free`, `longcat-2.0-free`,
`north-mini-code-free`, `nemotron-3-ultra-free`.

> **Note:** model lists drift. The registry must be **data-driven** (see §6.3)
> with a static snapshot as fallback, not hardcoded logic.

### 6.2 Claude Code picker constraint

Claude Code's `/model` picker only keeps gateway-discovered ids whose `id`
contains `claude` or `anthropic` (case-insensitive). Raw OpenCode ids like
`deepseek-v4-flash-free` are filtered out. Solution (from `claude.md` §2.10):

- The proxy serves `GET /v1/models` with **reversible alias ids** that pass the
  filter, e.g. `claude-ocx-<provider>--<model>`, and `display_name` set to the
  real OpenCode name. The picker shows the display name; the proxy maps the
  alias back to the real id on `/v1/messages`.
- Requires `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` **and** a credential
  (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) on the client, or the
  discovery fetch never fires.
- A `[1m]` suffix on an alias id adds a context-variant picker row; the proxy
  strips it before routing.
- Fallback for setups where discovery can't run: `ANTHROPIC_CUSTOM_MODEL_OPTION`
  + `ANTHROPIC_DEFAULT_*_MODEL` env vars (5 slots, real ids shown).

Alias scheme (reversible, deterministic):

```
claude-ocx-<format>--<model>          # e.g. claude-ocx-oa-compat--deepseek-v4-flash-free
claude-ocx-<provider>--<model>        # e.g. claude-ocx-anthropic--claude-sonnet-4-6
```

The proxy strips the `claude-ocx-` prefix and `--` separator to recover the
real id. `display_name` = real OpenCode model name (e.g. "DeepSeek V4 Flash
(Free)").

### 6.3 Registry design

- **Static snapshot** (checked in, generated from research): per backend, a
  list of `{ id, format, contextWindow, maxOutput, capabilities }`.
- **Dynamic refresh** (optional, on startup + TTL): fetch
  `https://models.opencode.ai/catalog.json` and the backend's
  `GET /v1/models`; merge with the static snapshot. Catalog entries are
  provider-prefixed (e.g. `deepseek/deepseek-v4-pro`) — match by suffix.
- **Cache** to `~/.claude-opencode-proxy/models.json` (mode 0600) so startup
  works offline; refresh failures fall back to the cache, then the static
  snapshot.
- **Filtering:** only expose models whose backend matches the resolved backend
  (§2). Never expose a model the backend can't serve.

### 6.4 Context-window metadata (from catalog research)

Key values for the registry (context / max output tokens):

| Model | Context | Max output |
| :-- | --: | --: |
| `deepseek-v4-pro` / `deepseek-v4-flash` | 1,000,000 | 384,000 |
| `glm-5.2` | 1,000,000 | 131,072 |
| `glm-5.1` | 200,000 | 131,072 |
| `kimi-k3` | 1,048,576 | 131,072 |
| `kimi-k2.6` / `kimi-k2.7-code` | 262,144 | 262,144 |
| `minimax-m3` | 512,000 | 128,000 |
| `minimax-m2.5` / `m2.7` | 204,800 | 131,072 |
| `qwen3.8-max` | 1,000,000 | 131,072 |
| `qwen3.7-max` | 1,000,000 | 65,536 |
| `qwen3.7-plus` | 1,000,000 | 64,000 |
| `claude-fable-5` / `opus-5` / `opus-4-8` / `opus-4-7` / `opus-4-6` / `sonnet-5` | 1,000,000 | 128,000 |
| `claude-sonnet-4-6` | 1,000,000 | 64,000 |
| `claude-sonnet-4-5` / `haiku-4-5` | 200,000 | 64,000 |
| `gpt-5.6-*` / `gpt-5.5*` / `gpt-5.4*` | 1,050,000 | 128,000 |
| `gpt-5.3-codex*` / `gpt-5.2` / `gpt-5.1` / `gpt-5` / `gpt-5-nano` | 400,000 | 128,000 |
| `gemini-3.6-flash` / `3.5-flash*` / `3.1-pro` | 1,048,576 | 65,536 |
| `grok-4.5` | 500,000 | 500,000 |
| `grok-build-0.1` | 256,000 | 256,000 |
| `north-mini-code-1-0` | 256,000 | 64,000 |
| `nemotron-3-ultra-550b-a55b` | 1,000,000 | 128,000 |
| `longcat-2.0` | 1,000,000 | 131,072 |
| `laguna-s-2.1` | 1,048,576 | 32,768 |
| `mimo-v2.5` / `mimo-v2.5-pro` | 1,048,576 | 131,072 |
| `hy3` | 256,000 | 64,000 |

The proxy reports these via `CLAUDE_CODE_MAX_CONTEXT_TOKENS`-compatible
metadata (the `[1m]` alias variant and/or the `/v1/models` response) so Claude
Code sizes its context correctly.

---

## 7. Capability Detection

### 7.1 Capability list (from the spec)

context window, max output tokens, tool/function calling, vision, reasoning,
streaming, prompt caching, structured/JSON output, file/document, computer-use,
audio, web search, embeddings, provider extensions.

### 7.2 Strategy: dynamic discovery with fallback registry

1. **Primary — static metadata registry** (from `catalog.json` fields:
   `reasoning`, `tool_call`, `attachment`, `structured_output`,
   `modalities.input`, `limit.context`, `limit.output`). This is authoritative
   and offline-safe.
2. **Secondary — live probe** (optional, opt-in, cached): for a model with
   unknown capabilities, send a minimal request to the backend and inspect the
   response/error. E.g. a `tools`-bearing request that returns
   `400 ... not supported` implies no tool calling. Probing is expensive and
   rate-limited, so it is **off by default** and results are cached.
3. **Tertiary — conservative defaults** for unknown models: assume
   `streaming: true` (all OpenCode models stream), `tools: true` (most do),
   `reasoning: false`, `vision: false`, `contextWindow: 200_000`,
   `maxOutput: 64_000`. Claude Code degrades gracefully when a capability is
   reported false (it simply won't send images/tools).

### 7.3 Capability → Claude Code behavior

| Capability | How Claude Code uses it | Proxy action |
| :-- | :-- | :-- |
| context window | sizes context, truncates | report via metadata / `[1m]` alias |
| max output | sets `max_tokens` | clamp `max_tokens` to model max |
| tool calling | sends `tools` | strip `tools` if model lacks it (else 400) |
| vision | sends image blocks | strip image blocks if unsupported (else 400) |
| reasoning | sends `thinking` | strip `thinking` if unsupported; map to `reasoning_effort` for openai/google |
| streaming | always streams | always translate SSE |
| prompt caching | sends `cache_control` | forward; strip if backend rejects |
| structured output | sends `output_config` / `response_format` | forward only if supported |
| file/document | sends file blocks | strip if unsupported |
| computer-use | sends `computer` tool | strip if unsupported |
| audio | audio blocks | strip if unsupported |
| web search | `web_search` tool | strip if unsupported |
| embeddings | n/a (Claude Code doesn't use) | n/a |

**Rule:** never let an unsupported capability reach the backend (it 400s and
breaks the session). Strip or downgrade before forwarding; log a warning.

---

## 8. Configuration

### 8.1 Env vars

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `OPENCODE_BACKEND` | auto | `zen` \| `go` \| `free` (override) |
| `OPENCODE_ZEN_API_KEY` | — | Zen key (→ `zen` backend) |
| `OPENCODE_GO_API_KEY` | — | Go key (→ `go` backend) |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | override upstream base (testing) |
| `OPENCODE_PORT` | `8787` | listen port |
| `OPENCODE_HOST` | `127.0.0.1` | listen host |
| `OPENCODE_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `600000` | upstream request timeout (match Claude Code's `API_TIMEOUT_MS`) |
| `OPENCODE_MAX_RETRIES` | `2` | upstream retries on transient errors |
| `OPENCODE_MODEL_CACHE_TTL` | `86400` | model registry refresh TTL (s) |
| `OPENCODE_ENABLE_PROBES` | `false` | live capability probing |
| `OPENCODE_STRIP_UNSUPPORTED` | `true` | strip unsupported capabilities |
| `OPENCODE_EMIT_COST_PINGS` | `false` | emit `cost` ping chunks (reference does; optional) |

### 8.2 Claude Code side (documented in README)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=<opencode-key>   # or ANTHROPIC_API_KEY
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
# optional hardening:
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_THINKING=1        # if backend rejects `thinking`
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

---

## 9. Streaming Behaviour

1. **Always stream.** Claude Code requires SSE; buffering stalls it.
2. **Forward keep-alive `ping` events.** Claude Code aborts a stream silent for
   300 s (byte-level watchdog). During long thinking pauses, pings are the only
   traffic. The proxy must emit a `ping` at least every ~30 s if upstream is
   silent, and forward upstream pings verbatim.
3. **Forward error bodies unmodified** (see §5.7).
4. **Terminal marker:** end the stream with `data: [DONE]` for oa-compat
   upstreams; Anthropic streams end with `message_stop` (no `[DONE]` needed).
   The proxy must emit the correct terminator for the **client** format
   (Anthropic: `message_stop`).
5. **Chunk framing:** Anthropic SSE is `event: <type>\n` + `data: <json>\n\n`.
   oa-compat is `data: <json>\n\n`. The proxy re-frames per the client format.
6. **Abort propagation:** when Claude Code aborts, cancel the upstream fetch
   (propagate `AbortSignal`).
7. **Cost pings (optional):** the reference emits a `ping` with a `cost` field
   after the final chunk. Off by default; harmless to omit.

---

## 10. Edge Cases

| Case | Handling |
| :-- | :-- |
| Unknown model id | `404`/`400` with Anthropic error envelope; never silently route |
| Model id with `[1m]` suffix | strip suffix, route to base model |
| Alias id (`claude-ocx-...`) | map to real id before routing |
| Model not in backend's set | reject (Claude Code should never see it via `/v1/models`, but guard anyway) |
| `max_tokens` > model max | clamp to model max (avoid 400) |
| `thinking` on non-reasoning model | strip or map to `reasoning_effort` |
| `cache_control` on unsupported backend | strip (avoid 400) |
| Empty `system` array | drop (backend may reject empty) |
| Tool call with malformed JSON args | pass raw string (reference behavior) |
| Upstream 429 / usage limit | forward status + `retry-after`; don't retry forever |
| Upstream 401 (bad key) | forward; log clear message |
| Upstream silent > 300 s | emit `ping` keep-alives |
| Mid-stream upstream error | forward error event verbatim, then close |
| `count_tokens` unavailable | local estimate fallback (Claude Code handles) |
| Free-tier privacy | log a warning that prompts may be retained (see Risks) |
| CORS / OPTIONS | respond 200 with `Access-Control-Allow-*` |
| Unknown format in registry | treat as `oa-compat` (most permissive) + log |

---

## 11. Implementation Phases

**Phase 0 — Scaffold.** TypeScript project, `tsconfig`, `package.json`,
`vitest`, lint. Config loader + backend resolution + logging + health endpoint.
*Exit: `GET /healthz` returns 200.*

**Phase 1 — Passthrough (anthropic-format models).** Implement
`/v1/messages` for models whose format is `anthropic`: forward body/headers
with auth injection, stream passthrough (identity converter), ping keep-alive,
error passthrough. This is the "happy path" and validates the whole HTTP/SSE
plumbing. *Exit: Claude Code talks to a `claude-sonnet-4-6`-format model end to
end.*

**Phase 2 — Canonical IR + converters.** Implement `Common*` types and the
`from`/`to` converters for all four formats (unit-tested against fixtures from
the reference). *Exit: all converter pairs pass fixture tests.*

**Phase 3 — Full translation routing.** Wire `createBodyConverter` /
`createResponseConverter` / `createStreamPartConverter` into the router.
Support `oa-compat` (free + DeepSeek/GLM/Kimi), `openai` (GPT/Grok), `google`
(Gemini). *Exit: each format family works end-to-end with a real model.*

**Phase 4 — Model registry & discovery.** Static snapshot + catalog fetch +
cache + alias-id `/v1/models` + `[1m]` variants + backend filtering. *Exit:
`/v1/models` shows only the active backend's models with alias ids.*

**Phase 5 — Capability detection.** Registry-driven capability table, strip
unsupported fields, optional live probes. *Exit: unsupported capabilities never
reach upstream.*

**Phase 6 — Hardening.** `count_tokens`, retries, timeouts, abort propagation,
cost pings, CORS, README with Claude Code setup, Dockerfile. *Exit: full
integration test suite green.*

---

## 12. Testing Strategy

### 12.1 Unit tests (pure functions, no network)

- **Converters:** fixture-driven. For each `from`/`to` pair, feed a reference
  fixture (request body, response body, SSE chunk sequence) and assert the
  canonical shape and the round-trip. Include the reference's exact fixtures
  (e.g. Anthropic `message_start`/`content_block_*`/`message_delta` sequences,
  oa-compat `data:` chunks, Responses `event:` chunks, Gemini `data:` chunks).
- **Usage normalization**: per-format usage fixtures → expected `UsageInfo`
  (incl. the `adjustCacheUsage` 90% estimate).
- **Stop/finish reason mapping**: all pairs.
- **Alias mapping**: `claude-ocx-*` → real id, `[1m]` stripping.
- **Config/backend resolution**: env matrix → backend + model set.

### 12.2 Integration tests (mock upstream)

Spin the proxy against a **mock OpenCode server** (a tiny HTTP server that
emits canned SSE/JSON per format). Assert:
- passthrough correctness (anthropic → anthropic),
- translation correctness (each format → anthropic),
- streaming: event order, framing, `ping` keep-alive, `[DONE]`/`message_stop`,
- tool calling round-trip (request tools → upstream tools → response tool_use),
- error translation (upstream error body forwarded verbatim; proxy errors in
  Anthropic envelope),
- capability stripping (tools/thinking/images removed when unsupported),
- model discovery (`/v1/models` shape + alias ids + backend filtering),
- auth header per format.

### 12.3 End-to-end (manual, documented)

- Real Claude Code against the proxy for each backend: free (no key), Zen key,
  Go key.
- `/model` picker shows the right models; a session with tool calls completes;
  a long-thinking session doesn't stall (ping keep-alive).
- `count_tokens` path and fallback.

### 12.4 Regression

- Re-run converter fixtures whenever the reference implementation changes
  (pin a version; diff fixtures).
- Golden-file the `/v1/models` response per backend.

---

## 13. Risks

| Risk | Mitigation |
| :-- | :-- |
| **Model drift** — OpenCode adds/removes models, changes formats | static snapshot + catalog refresh + cache; unknown models rejected loudly |
| **Catalog schema change** | defensive parsing; fall back to static snapshot |
| **Free-tier privacy** — prompts may be retained/used for training | warn on free backend; document; user opt-in |
| **Usage-limit fallback** — Go falls back to free models at limit | proxy exposes only the configured backend's models; document the fallback |
| **Claude Code picker filter** — ids must contain `claude`/`anthropic` | alias scheme (§6.2); document `ANTHROPIC_CUSTOM_MODEL_OPTION` fallback |
| **Beta headers/fields** — Claude Code sends `anthropic-beta`, `thinking`, `output_config` | forward verbatim to `anthropic`-format backends; strip for others; document `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` |
| **Streaming watchdog** — 300 s silent abort | ping keep-alive |
| **Error-wording matching** — Claude Code retries on upstream wording | forward error bodies verbatim |
| **Rate limits** — probing/refresh hammering | cache, TTL, probes off by default |
| **Token accounting** — wrong context window breaks sessions | accurate metadata registry; `[1m]` variants |
| **Attribution block** — system prompt first entry | forward `system` unchanged; document `CLAUDE_CODE_ATTRIBUTION_HEADER=0` |

---

## 14. Future Improvements

- **Multi-backend simultaneous** (expose Zen + Go + Free with a prefix in the
  alias id, e.g. `claude-ocx-zen--...` vs `claude-ocx-go--...`).
- **Cost display** in Claude Code via `cost` pings (reference parity).
- **BYOK passthrough** for `byokProvider` models (OpenAI/Anthropic/Google
  native keys) — the reference supports it.
- **Health/usage dashboard** endpoint (`/metrics`).
- **Docker image** + systemd unit.
- **`/v1/messages/count_tokens`** real implementation for non-anthropic
  backends (currently local estimate).
- **WebSocket** support for OpenAI Responses (reference has it; Claude Code
  doesn't need it).
- **Config file** (`~/.claude-opencode-proxy/config.json`) in addition to env.
- **Auto-refresh** of the model registry on a schedule (not just startup).
- **Structured logging** (JSON lines) for log aggregation.

---

## Appendix A — Reference sources

- `anomalyco/opencode` (dev branch):
  `packages/console/app/src/routes/zen/util/{handler,provider/*,variant,error,modelsHandler}.ts`,
  `packages/console/core/src/model.ts` (ZenData catalog).
- `claude.md` — Claude Code client contract (headers, SSE, model picker, env).
- `endpoint.md` — OpenCode Zen/Go endpoints, formats, auth, discovery.
- `https://models.opencode.ai/catalog.json` — model metadata (299 models).
- `https://opencode.ai/docs/zen/`, `https://opencode.ai/docs/go/` — docs tables.

## Appendix B — Key Claude Code env vars (from `claude.md`)

`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_DISABLE_THINKING=1`,
`CLAUDE_CODE_ATTRIBUTION_HEADER=0`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
(any value blocks discovery), `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`.