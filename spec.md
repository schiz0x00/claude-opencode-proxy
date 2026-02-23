# claude-opencode-proxy — Technical Specification

> **Status:** Implementation-ready. This document is the normative technical
> spec derived from `plan.md` (architecture & strategy), `claude.md` (Claude
> Code client contract), and `endpoint.md` (OpenCode Zen/Go endpoints &
> formats). Where this spec and the plan disagree, **this spec wins**.
>
> **Audience:** implementer(s). Every module, interface, and behavior below is
> concrete enough to write code against without further decisions.

---

## 1. Purpose & Scope

A single-process HTTP proxy that presents one **Anthropic Messages API**
surface to Claude Code and translates to the correct **OpenCode** wire format
per model (Zen, Go, or anonymous Free tier).

- **Client side (Claude Code):** `POST /v1/messages` (SSE streaming),
  `POST /v1/messages/count_tokens`, `GET /v1/models`.
- **Backend side (OpenCode):** one of four formats selected per model —
  `anthropic` (`/v1/messages`), `oa-compat` (`/v1/chat/completions`),
  `openai` (`/v1/responses`), `google` (`/v1/models/<id>`).

**Out of scope:** billing, quotas, multi-tenancy, response caching, UI,
persistence (beyond an optional model-cache file), general-purpose gateway.

---

## 2. Tech Stack & Project Layout

### 2.1 Stack

| Concern | Choice | Rationale |
| :-- | :-- | :-- |
| Runtime | Node.js ≥ 20 (LTS 24 recommended) | native `fetch`, `ReadableStream`, `AbortSignal` |
| Language | TypeScript 7.x, `strict: true`, `module: NodeNext` | type safety for the converter matrix |
| HTTP layer | `hono` (v4) on `node:http` | minimal (~14 KB), first-class streaming, no deps beyond `hono` |
| Validation | `zod` (only for config + inbound body shape) | fail fast on bad config |
| Tests | `vitest` | fast, TS-native |
| Dev runner | `tsx watch` | no build step during dev |
| Build | `tsc` → `dist/`, single entry `dist/index.js` | deployable artifact |

Dependencies (runtime): `hono`. Dev: `typescript`, `tsx`, `vitest`, `zod`
(optional — config only), `@types/node`.

### 2.2 Directory layout

```
src/
  index.ts              # entrypoint: load config, start server, graceful shutdown
  config.ts             # env parsing + validation + typed Config
  backend.ts            # backend resolution (zen | go | free) + base URL
  server.ts             # hono app: routes, CORS, error middleware, request pipeline
  router.ts             # POST /v1/messages orchestration (translate + forward + stream)
  modelRegistry.ts      # per-backend model sets, alias mapping, metadata, cache
  capability.ts         # capability table + strip/downgrade logic
  auth.ts               # key extraction + per-format header injection
  stream.ts             # SSE pump: read upstream, translate, re-emit, keep-alive
  errors.ts             # ProxyError + Anthropic error envelope
  logging.ts            # leveled logger (debug/info/warn/error), optional JSON
  health.ts             # GET /healthz, /ready, /
  translate/
    types.ts            # Format, CommonRequest/Response/Chunk, UsageInfo
    provider.ts         # ProviderHelper interface + converter factories
    anthropic.ts        # from/to Anthropic Messages
    openai-compat.ts    # from/to oa-compat (chat/completions)
    openai.ts           # from/to OpenAI Responses
    google.ts           # from/to Gemini generateContent
  data/
    models.static.ts    # checked-in static model snapshot (per backend)
test/
  fixtures/             # reference converter fixtures (JSON/SSE sequences)
  unit/                 # converter, usage, alias, config tests
  integration/          # proxy vs mock upstream
```

---

## 3. Runtime Architecture

### 3.1 Request pipeline (`POST /v1/messages`)

```
Claude Code
   │  POST /v1/messages  (Anthropic body, stream:true)
   ▼
server.ts ──► router.ts
   │
   ├─ 1. parse body + headers
   ├─ 2. resolveModel(id)          → ModelEntry (alias/[1m] handled)
   ├─ 3. resolveBackend(config)     → "zen" | "go" | "free"
   ├─ 4. selectProvider(format)     → ProviderHelper
   ├─ 5. createBodyConverter("anthropic", format) → translate request
   ├─ 6. auth.injectHeaders(format, key)          → correct auth header
   ├─ 7. build upstream URL (modifyUrl)           → POST
   │
   ├─ non-stream: createResponseConverter(format, "anthropic") → JSON 200
   └─ stream:     pumpStream(upstream, format, "anthropic")
                     ├─ read SSE, translate each part
                     ├─ keep-alive ping every 30 s if silent
                     ├─ forward errors verbatim
                     └─ terminate with message_stop
```

### 3.2 Concurrency model

- Single Node.js process, async I/O throughout. No worker threads.
- Each request is independent; upstream `fetch` is aborted via `AbortSignal`
  when the client disconnects.
- The model cache file is read once at startup and written atomically
  (write-temp-then-rename); concurrent refresh is guarded by a mutex.

---

## 4. Configuration

### 4.1 Env vars (normative)

| Variable | Default | Type | Purpose |
| :-- | :-- | :-- | :-- |
| `OPENCODE_BACKEND` | *(auto)* | `"zen"\|"go"\|"free"` | explicit backend override |
| `OPENCODE_ZEN_API_KEY` | — | string | Zen key → backend `zen` |
| `OPENCODE_GO_API_KEY` | — | string | Go key → backend `go` |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | URL | upstream base override (testing) |
| `OPENCODE_PORT` | `8787` | int 1–65535 | listen port |
| `OPENCODE_HOST` | `127.0.0.1` | string | listen host |
| `OPENCODE_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` | log verbosity |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `600000` | int > 0 | upstream timeout |
| `OPENCODE_MAX_RETRIES` | `2` | int ≥ 0 | retries on transient errors |
| `OPENCODE_MODEL_CACHE_TTL` | `86400` | int ≥ 0 | registry refresh TTL (s) |
| `OPENCODE_ENABLE_PROBES` | `false` | bool | live capability probing |
| `OPENCODE_STRIP_UNSUPPORTED` | `true` | bool | strip unsupported capabilities |
| `OPENCODE_EMIT_COST_PINGS` | `false` | bool | emit `cost` ping chunks |
| `OPENCODE_MODEL_CACHE_FILE` | `~/.claude-opencode-proxy/models.json` | path | cache file (mode 0600) |

### 4.2 Backend resolution (normative precedence)

1. `OPENCODE_BACKEND` set → use it verbatim (validate ∈ `{zen,go,free}`).
2. Else `OPENCODE_GO_API_KEY` set → `go`.
3. Else `OPENCODE_ZEN_API_KEY` set → `zen`.
4. Else → `free`.

**Base URL resolution:** `OPENCODE_BASE_URL` if set; else `zen`/`free` →
`https://opencode.ai/zen/v1`, `go` → `https://opencode.ai/zen/go/v1`.

**Key handling:** the proxy accepts the key from Claude Code in either
`x-api-key` or `Authorization: Bearer`. It re-emits to OpenCode in the
format-correct header (see §7.4). For backend `free`, no key is required and
no auth header is sent upstream.

### 4.3 `Config` type

```ts
type Backend = "zen" | "go" | "free";
type LogLevel = "debug" | "info" | "warn" | "error";

interface Config {
  backend: Backend;
  zenApiKey?: string;
  goApiKey?: string;
  baseUrl: string;                 // resolved upstream base (no trailing slash)
  port: number;
  host: string;
  logLevel: LogLevel;
  requestTimeoutMs: number;
  maxRetries: number;
  modelCacheTtl: number;
  enableProbes: boolean;
  stripUnsupported: boolean;
  emitCostPings: boolean;
  modelCacheFile: string;
}

function loadConfig(env: NodeJS.ProcessEnv): Config;   // throws on invalid
```

---

## 5. HTTP API Contract (client-facing)

| Method | Path | Behavior |
| :-- | :-- | :-- |
| `POST` | `/v1/messages` | Anthropic Messages; streaming or non-streaming |
| `POST` | `/v1/messages/count_tokens` | forward if backend is anthropic-format capable; else local estimate |
| `GET` | `/v1/models` | registry for active backend, alias ids, Anthropic-native shape |
| `GET` | `/healthz` | liveness → `200 {"status":"ok"}` |
| `GET` | `/ready` | readiness → `200` once config + registry loaded |
| `GET` | `/` | info JSON: version, backend, model count |
| `OPTIONS` | `*` | CORS preflight → `204` with `Access-Control-Allow-*` |

### 5.1 `GET /v1/models` response shape

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "claude-ocx-oa-compat--deepseek-v4-flash-free",
      "object": "model",
      "created": 1786130896,
      "owned_by": "opencode",
      "display_name": "DeepSeek V4 Flash (Free)"
    }
  ]
}
```

- Only models for the **active backend** are listed (§10).
- `id` is the reversible alias; `display_name` is the real OpenCode name.
- A `[1m]` context-variant row is added for models with
  `contextWindow ≥ 1_000_000` (id = alias + `[1m]`, same display name).

### 5.2 `POST /v1/messages/count_tokens`

- If backend format is `anthropic` (i.e. the model family is anthropic-native
  or backend is `zen`/`go` with anthropic models): forward to
  `{base}/v1/messages/count_tokens` with the same body, return upstream JSON.
- Else: return a local estimate:
  `input_tokens ≈ ceil(chars / 4)` summed over system + messages, plus
  `output_tokens: 0`. Shape:
  `{"input_tokens": N, "output_tokens": 0}`.
- Claude Code falls back to its own local estimate if this endpoint 404s, so
  failure is non-fatal.

---

## 6. Core Types (Canonical IR)

All four formats convert **to and from** one canonical shape (OpenAI
chat-completion-like), so any format ↔ any format is two composed converters.

```ts
type Format = "anthropic" | "google" | "openai" | "oa-compat";

interface CommonMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CommonContentPart[];
  tool_call_id?: string;                 // role === "tool"
  tool_calls?: CommonToolCall[];         // role === "assistant"
  name?: string;
}

type CommonContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface CommonToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };  // arguments = JSON string
}

interface CommonTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;  // JSON Schema
  };
}

interface CommonRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  messages: CommonMessage[];
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
  usage?: CommonUsage;
}

interface CommonChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [{
    index: number;
    delta: { role?: "assistant"; content?: string; tool_calls?: CommonToolCall[] };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }];
  usage?: CommonUsage;
}

interface CommonUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
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

---

## 7. Provider Abstraction

### 7.1 `ProviderHelper` interface (mirrors reference `anomalyco/opencode`)

```ts
interface ProviderHelper {
  format: Format;
  modifyUrl: (providerApi: string, isStream?: boolean) => string;
  modifyHeaders: (headers: Headers, apiKey: string, stickyId: string) => void;
  modifyBody: (body: Record<string, any>) => Record<string, any>;
  createBinaryStreamDecoder:
    () => ((chunk: Uint8Array) => Uint8Array | undefined) | undefined;
  createUsageParser: () => { parse: (chunk: string) => void; retrieve: () => any };
  extractUsage: (response: any) => any;
  normalizeUsage: (usage: any) => UsageInfo;
}
```

### 7.2 Per-format helper table (normative)

| Format | URL suffix (stream) | URL suffix (non-stream) | Auth header | Extra headers/body |
| :-- | :-- | :-- | :-- | :-- |
| `anthropic` | `/v1/messages` | `/v1/messages` | `x-api-key` | `anthropic-version: 2023-06-01`; `anthropic-beta: context-1m-2025-08-07` when model id contains `sonnet` or `opus-4-6` |
| `oa-compat` | `/v1/chat/completions` | `/v1/chat/completions` | `Authorization: Bearer` | add `stream_options: { include_usage: true }` when streaming |
| `openai` | `/v1/responses` | `/v1/responses` | `Authorization: Bearer` | — |
| `google` | `/v1/models/<id>:streamGenerateContent?alt=sse` | `/v1/models/<id>:generateContent` | `x-goog-api-key` | model id embedded in URL |

> **Note:** the reference's `createBodyConverter` has **no `google` egress
> branch** (anomalyco/opencode#39696). The proxy implements google↔canonical
> converters itself (§8.6) and routes gemini models to the native google
> endpoint.

### 7.3 Converter factories

```ts
type BodyConverter = (body: any) => any;
type ResponseConverter = (resp: any) => any;
type StreamPartConverter = (part: string) => string;

function createBodyConverter(from: Format, to: Format): BodyConverter;
function createResponseConverter(from: Format, to: Format): ResponseConverter;
function createStreamPartConverter(from: Format, to: Format): StreamPartConverter;
```

Rules:
- `from === to` → identity (passthrough).
- Otherwise `from<Format>X(...)` → canonical → `to<Format>X(...)`.
- Stream converters return the **input string unchanged** when a chunk is not
  parseable (error / keep-alive passthrough).

### 7.4 Auth injection

```ts
function extractApiKey(headers: Headers): string | null;
//  1. x-api-key
//  2. Authorization: Bearer <token>
//  else null

function injectAuth(headers: Headers, format: Format, apiKey?: string): void;
//  anthropic | google → headers.set("x-api-key", apiKey)
//  oa-compat | openai → headers.set("Authorization", `Bearer ${apiKey}`)
//  apiKey undefined (free) → delete both auth headers
```

---

## 8. Format Translation Specifications

### 8.1 Anthropic → canonical request (`fromAnthropicRequest`)

| Anthropic field | Canonical |
| :-- | :-- |
| `system` (string or `{type:"text",text}[]`) | `messages` with `role:"system"` (skip empty) |
| `messages[].content` `text` block | `{type:"text", text}` part |
| `messages[].content` `image` block | `{type:"image_url", image_url:{url}}` from `source.url` or `source.base64`+`media_type` |
| `messages[].content` `tool_use` block | assistant message with `tool_calls:[{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]` |
| `messages[].content` `tool_result` block | `{role:"tool", tool_call_id, content}` |
| `max_tokens` | `max_tokens` |
| `temperature`, `top_p` | same |
| `stop_sequences` | `stop` |
| `tools` (`{name,description,input_schema}`) | `{type:"function", function:{name, description, parameters}}` |
| `tool_choice` | `tool_choice` |
| `stream` | `stream` |

### 8.2 Canonical → Anthropic request (`toAnthropicRequest`)

- `system` messages → `system` array of `{type:"text", text}` blocks; add
  `cache_control:{type:"ephemeral"}` to the **first 4** system blocks.
- user parts → `text` / `image` blocks; assistant `content` + `tool_calls` →
  `text` + `tool_use` blocks (`input` = JSON.parse(arguments), fallback raw
  string); `role:"tool"` → `tool_result` with `tool_use_id`.
- `tools` → `{name, description, input_schema}`.

### 8.3 Anthropic → canonical response (`fromAnthropicResponse`)

- `id` `msg_*` → `chatcmpl_*`.
- `content` blocks → `message.content` (joined text) + `message.tool_calls`
  (from `tool_use`, `input` JSON-stringified).
- `stop_reason` → `finish_reason`: `end_turn`→`stop`, `tool_use`→`tool_calls`,
  `max_tokens`→`length`, `content_filter`→`content_filter`.
- `usage` → `{prompt_tokens: input_tokens, completion_tokens: output_tokens,
  total_tokens, prompt_tokens_details:{cached_tokens: cache_read_input_tokens}}`.

### 8.4 Canonical → Anthropic response (`toAnthropicResponse`)

- `message.content` + `message.tool_calls` → `content` blocks (`text` +
  `tool_use` with `input` JSON-parsed, fallback raw string).
- `finish_reason` → `stop_reason` (inverse of §8.3).
- `usage` → `input_tokens`, `output_tokens`, `cache_read_input_tokens`.

### 8.5 Streaming chunk mapping

**Anthropic SSE** framing: `event: <type>\n` + `data: <json>\n\n`.

| Anthropic event | Canonical chunk |
| :-- | :-- |
| `content_block_start` (text) | `delta.content` (empty) |
| `content_block_delta` `text_delta` | `delta.content` |
| `content_block_start` (tool_use) | `delta.tool_calls[0]` with `function.name` |
| `content_block_delta` `input_json_delta` | `delta.tool_calls[0].function.arguments` |
| `message_delta` | `finish_reason` (stop_reason mapped) |
| `message_start` / `message_stop` / `ping` | passthrough (no canonical chunk) |

**Canonical → Anthropic SSE** (inverse):

| Canonical | Anthropic event |
| :-- | :-- |
| `delta.content` | `content_block_delta` `text_delta` |
| `delta.tool_calls[].function.name` | `content_block_start` `tool_use` |
| `delta.tool_calls[].function.arguments` | `content_block_delta` `input_json_delta` |
| `finish_reason` | `message_delta` `{stop_reason, stop_sequence:null}` |
| `usage` | `message_delta` `usage` |

**oa-compat SSE** (`data: {...}\n\n`): `delta.content`, `delta.tool_calls`
(with `index`), `finish_reason`, final usage chunk
(`stream_options.include_usage`), terminal `data: [DONE]`.

**openai (Responses) SSE** (`event: X\n` + `data: {...}\n\n`):
`response.output_text.delta` → text; `response.output_item.added`
(function_call) → tool name; `response.function_call_arguments.delta` → tool
args; `response.completed` → finish_reason + usage.

**google SSE** (`data: {...}\n\n`): `candidates[0].content.parts[].text`,
`functionCall` parts, `finishReason`, `usageMetadata`.

### 8.6 Google ↔ canonical (implemented by the proxy, not copied)

- **Request:** `contents` (array of `{role, parts}`) ↔ canonical messages.
  `systemInstruction` ↔ system message. `generationConfig` ↔
  `max_tokens`/`temperature`/`top_p`/`stop`. `tools` (functionDeclarations) ↔
  `tools`. `toolConfig` ↔ `tool_choice`.
- **Response:** `candidates[0].content.parts[]` (text + `functionCall`) ↔
  `message.content` + `tool_calls`. `finishReason` ↔ `finish_reason`
  (`STOP`→`stop`, `MAX_TOKENS`→`length`, `TOOL_CALLS`→`tool_calls`).
- **Usage:** `usageMetadata` → `UsageInfo` (see §8.7).

### 8.6 Usage normalization (per format → `UsageInfo`)

| Format | inputTokens | outputTokens | reasoning | cacheRead | cacheWrite5m |
| :-- | :-- | :-- | :-- | :-- | :-- |
| anthropic | `input_tokens` | `output_tokens` | — | `cache_read_input_tokens` | `cache_creation.ephemeral_5m_input_tokens` ?? `cache_creation_input_tokens` |
| oa-compat | `prompt_tokens - cached` | `completion_tokens` | `completion_tokens_details.reasoning_tokens` | `cached_tokens` (moonshot) ?? `prompt_tokens_details.cached_tokens`; if none and `adjustCacheUsage`, estimate `floor(input*0.9)` | `prompt_tokens_details.cache_creation_input_tokens` |
| openai | `input_tokens - cached` | `output_tokens` | `output_tokens_details.reasoning_tokens` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` |
| google | `promptTokenCount - cachedContentTokenCount` | `candidatesTokenCount` | `thoughtsTokenCount` | `cachedContentTokenCount` | — |

---

## 9. Streaming Protocol

### 9.1 `pumpStream` contract

```ts
interface PumpOptions {
  upstream: Response;          // fetch response with SSE body
  upstreamFormat: Format;
  clientFormat: Format;        // always "anthropic" for Claude Code
  signal?: AbortSignal;
  emitCostPings?: boolean;
  onError?: (err: Error) => void;
}

async function pumpStream(opts: PumpOptions): Promise<void>;
```

### 9.2 Rules (normative)

1. **Always stream.** Never buffer a full upstream response.
2. **Keep-alive:** if no bytes have been relayed for **30 s**, emit
   `event: ping\ndata: {"type":"ping"}\n\n` to the client. Forward upstream
   `ping` events verbatim. (Claude Code aborts a stream silent for 300 s.)
3. **Error passthrough:** forward upstream error events/body **unmodified**.
4. **Termination:** client format is Anthropic → end with `message_stop`
   (no `data: [DONE]`). If the upstream is oa-compat, consume its
   `data: [DONE]` and do **not** forward it.
5. **Framing:** re-frame every part per the client format
   (`event:` + `data:` for Anthropic).
6. **Abort:** on client disconnect, `upstream.body.cancel()` and abort the
   fetch signal.
7. **Cost pings (optional):** after the final chunk, if `emitCostPings`, emit
   `event: ping\ndata: {"type":"ping","cost":{...}}\n\n` from normalized usage.

### 9.3 SSE parser

A line-based incremental parser that buffers partial lines and emits complete
SSE events (`event:` + `data:` pairs). Must handle CRLF, multi-line `data:`,
and comments (`:` lines ignored). Reused for all formats; the event→chunk
mapping is per-format.

---

## 10. Model Registry & Discovery

### 10.1 Model sets (static snapshot, normative baseline)

**Zen** (`https://opencode.ai/zen/v1`):

| Format | Models |
| :-- | :-- |
| `anthropic` | `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus` |
| `openai` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5`, `gpt-5-codex`, `gpt-5-nano`, `grok-4.5`, `grok-build-0.1` |
| `oa-compat` | `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5` |
| `google` | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash` |

**Go** (`https://opencode.ai/zen/go/v1`): documented 19 + 6 undocumented
(`kimi-k2.5`, `glm-5`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`,
`hy3-preview`) — undocumented entries default to `oa-compat` format and are
flagged `format: "unknown"` for probing.

**Free** (Zen base, anonymous, all `oa-compat`): `big-pickle`,
`deepseek-v4-flash-free`, `mimo-v2.5-free`, `laguna-s-2.1-free`,
`ling-3.0-tiny-free`, `ling-3.0-flash-free`, `longcat-2.0-free`,
`north-mini-code-free`, `nemotron-3-ultra-free`.

### 10.2 Registry data structures

```ts
interface ModelEntry {
  id: string;                 // real OpenCode id
  format: Format;
  contextWindow: number;
  maxOutput: number;
  displayName?: string;
  capabilities: Capabilities;
  provider?: string;          // e.g. "deepseek", "anthropic"
}

interface Capabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  fileCompatibility: boolean;
  computerUse: boolean;
  audio: boolean;
  webSearch: boolean;
  embeddings: boolean;
}

interface ModelRegistry {
  getBackendModels(backend: Backend): ModelEntry[];
  resolveModel(id: string): ResolvedModel | undefined;
  toAliasId(entry: ModelEntry): string;
  fromAliasId(alias: string): string | undefined;   // real id or undefined
}

interface ResolvedModel {
  entry: ModelEntry;
  contextVariant?: "1m";      // set when [1m] suffix present
}
```

### 10.3 Alias scheme (reversible, deterministic)

```
claude-ocx-<format>--<model>
```

- Prefix `claude-ocx-` satisfies Claude Code's picker filter (id contains
  `claude`).
- Split on the **first** `--` after the prefix: left = `format`, right = real
  model id. Model ids never contain `--`, so this is lossless.
- `display_name` = real OpenCode model name (e.g. `DeepSeek V4 Flash (Free)`).
- `[1m]` suffix on the alias id adds a context-variant picker row; stripped
  before routing (sets `realVariant: "1m"`).
- Unknown/foreign ids that don't match the alias pattern are rejected with
  `404` (never silently routed).

### 10.4 Refresh & cache

1. **Static snapshot** (`data/models.static.json`) is authoritative baseline.
2. **Dynamic refresh** (startup + every `OPENCODE_MODEL_CACHE_TTL` s):
   - `GET {base}/v1/models` → live ids for the backend.
   - `GET https://models.opencode.ai/catalog.json` → metadata (context,
     output, capabilities). Catalog entries are provider-prefixed
     (`deepseek/deepseek-v4-pro`) — match by suffix.
   - Merge: live ids win; catalog metadata fills gaps; static fills the rest.
3. **Cache** to `modelCacheFile` (mode 0600). On refresh failure: cache →
   static. Offline startup works.
4. **Filtering:** only expose models whose backend matches the resolved
   backend. Never expose a model the backend can't serve.

### 10.5 Context-window metadata (baseline)

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

---

## 11. Capability Handling

### 11.1 Sources (priority order)

1. **Static metadata** (from `catalog.json` fields: `reasoning`, `tool_call`,
   `attachment`, `structured_output`, `modalities.input`, `limit.context`,
   `limit.output`). Authoritative, offline-safe.
2. **Live probe** (opt-in, `OPENCODE_ENABLE_PROBES=true`, cached): send a
   minimal request (e.g. a `tools`-bearing body) and inspect the response /
   error. `400 ... not supported` ⇒ capability false. Off by default.
3. **Conservative defaults** for unknown models: `streaming: true`,
   `tools: true`, `reasoning: false`, `vision: false`,
   `contextWindow: 200_000`, `maxOutput: 64_000`.

### 11.2 Strip/downgrade rules (applied before forwarding)

| Capability | If unsupported | Action |
| :-- | :-- | :-- |
| tool calling | `tools` in body | remove `tools` + `tool_choice`; log warn |
| vision | image blocks present | remove image blocks; log warn |
| reasoning | `thinking` present | remove `thinking`; for openai/google map to `reasoning_effort` |
| prompt caching | `cache_control` present | strip `cache_control` |
| structured output | `output_config` / `response_format` | strip |
| file/document | file blocks | strip |
| computer-use | `computer` tool | strip |
| audio | audio blocks | strip |
| web search | `web_search` tool | strip |

**Rule:** never let an unsupported capability reach the backend (it 400s and
breaks the session). Strip or downgrade before forwarding; log a warning.

---

## 12. Error Handling

### 12.1 Proxy-produced errors (Anthropic envelope)

```json
{ "type": "error", "error": { "type": "error", "message": "..." } }
```

Both top-level `type` and `error.type` set (matches `@ai-sdk/anthropic`
rendering).

### 12.2 Status code mapping

| Condition | Status | Notes |
| :-- | :-- | :-- |
| Bad/missing key | `401` | clear message |
| Region/forbidden | `403` | |
| Rate / usage limit (Go limit, free limit, monthly) | `429` | include `retry-after` when known |
| Unknown model | `404` | never silently route |
| Invalid request body | `400` | |
| Internal | `500` | |

### 12.3 Upstream errors

- **Forward upstream error bodies unmodified** (Claude Code's retry /
  feature-disable logic matches on upstream wording). Do **not** wrap.
- Mid-stream upstream error: forward the error event verbatim, then close the
  stream.
- Upstream `429`/`401`: forward status + body; do not retry forever
  (respect `OPENCODE_MAX_RETRIES` only for transient 5xx / network errors).

### 12.4 `ProxyError` type

```ts
class ProxyError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number);
}
```

---

## 13. Module-by-Module Implementation Spec

### 13.1 `config.ts`
- Parse env per §4.1; validate with `zod`; throw with a clear message listing
  the offending variable on failure.
- `loadConfig(env)` returns a frozen `Config`.

### 13.2 `backend.ts`
- `resolveBackend(env): Backend` — precedence per §4.2.
- `resolveBaseUrl(backend, override?): string`.
- `isFree(backend): boolean`.

### 13.3 `server.ts`
- Build `hono` app; register routes per §5.
- Global error middleware: catch `ProxyError` → Anthropic envelope; catch
  unknown → `500` envelope; log.
- CORS middleware: `OPTIONS *` → `204` with `Access-Control-Allow-Origin: *`,
  `-Methods: POST, GET, OPTIONS`, `-Headers: *`.
- `GET /` info: `{ name, version, backend, modelCount }`.

### 13.4 `router.ts`
- `handleMessages(c, config, registry): Response` — orchestrates §3.1.
- Steps: parse body → `resolveModel` → backend → provider → body converter →
  auth → upstream fetch → stream or JSON response.
- `handleCountTokens(c, config)` — §5.2.
- `handleModels(c, config)` — §5.1.

### 13.5 `modelRegistry.ts`
- `createRegistry(config): ModelRegistry` — loads snapshot, kicks off async
  refresh, returns a registry with `getBackendModels`, `resolveModel`,
  `toAliasId`, `fromAliasId`.
- `resolveModel` handles: real id (exact match), alias id (strip prefix +
  split), `[1m]` suffix, unknown → `undefined`.

### 13.6 `translate/provider.ts`
- `createBodyConverter`, `createResponseConverter`,
  `createStreamPartConverter` per §7.3.
- `getProvider(format): ProviderHelper` — returns the singleton helper.

### 13.7 `translate/*.ts`
- Each file exports `from<Format>Request`, `to<Format>Request`,
  `from<Format>Response`, `to<Format>Response`,
  `from<Format>StreamPart`, `to<Format>StreamPart` (pure functions).
- `anthropic.ts` also exports `fromAnthropicUsage` / `toAnthropicUsage`.

### 13.8 `stream.ts`
- `pumpStream(opts)` per §9.
- Internal: `createSseParser()`, `keepAliveTimer`, `translatePart`.

### 13.9 `auth.ts`
- `extractApiKey`, `injectAuth` per §7.4.

### 13.10 `errors.ts`
- `ProxyError`, `anthropicError(status, message, retryAfter?)`.

### 13.11 `logging.ts`
- `createLogger(level)` → `{ debug, info, warn, error }`; prefix timestamps;
  optional JSON lines (`OPENCODE_LOG_LEVEL` + `NODE_ENV=production`).

### 13.12 `health.ts`
- `GET /healthz` → `200 {"status":"ok"}`; `GET /ready` → `200` once config +
  registry loaded, else `503`.

### 13.13 `index.ts`
- `loadConfig` → `createRegistry` → `serve` → graceful shutdown on
  `SIGINT`/`SIGTERM` (close server, cancel in-flight fetches).

---

## 14. Testing Specification

### 14.1 Unit tests (pure, no network)

- **Converters:** fixture-driven. For each `from`/`to` pair, feed reference
  fixtures (request body, response body, SSE chunk sequence) and assert the
  canonical shape + round-trip. Include exact reference fixtures:
  Anthropic `message_start`/`content_block_*`/`message_delta` sequences,
  oa-compat `data:` chunks, Responses `event:` chunks, Gemini `data:` chunks.
- **Usage normalization:** per-format usage fixtures → expected `UsageInfo`
  (incl. `adjustCacheUsage` 90% estimate).
- **Stop/finish reason mapping:** all pairs.
- **Alias mapping:** `claude-ocx-*` → real id; `[1m]` stripping; unknown id.
- **Config/backend resolution:** env matrix → backend + model set.

### 14.2 Integration tests (mock upstream)

Spin the proxy against a mock OpenCode server emitting canned SSE/JSON per
format. Assert:
- passthrough correctness (anthropic → anthropic),
- translation correctness (each format → anthropic),
- streaming: event order, framing, `ping` keep-alive, `[DONE]`/`message_stop`,
- tool-calling round-trip (request tools → upstream tools → response tool_use),
- error translation (upstream body verbatim; proxy errors in Anthropic
  envelope),
- capability stripping (tools/thinking/images removed when unsupported),
- model discovery (`/v1/models` shape + alias ids + backend filtering),
- auth header per format.

### 14.3 End-to-end (manual, documented)

- Real Claude Code against the proxy for each backend: free (no key), Zen key,
  Go key.
- `/model` picker shows the right models; a session with tool calls completes;
  a long-thinking session doesn't stall (ping keep-alive).
- `count_tokens` path and fallback.

### 14.4 Regression

- Re-run converter fixtures whenever the reference implementation changes
  (pin a version; diff fixtures).
- Golden-file the `/v1/models` response per backend.

---

## 15. Acceptance Criteria & Implementation Order

**Phase 0 — Scaffold.** TS project, `tsconfig`, `package.json`, `vitest`,
lint. Config loader + backend resolution + logging + health.
*Exit: `GET /healthz` returns 200.*

**Phase 1 — Passthrough (anthropic-format models).** `/v1/messages` for
`anthropic`-format models: forward body/headers with auth injection, stream
passthrough (identity converter), ping keep-alive, error passthrough.
*Exit: Claude Code talks to a `claude-sonnet-4-6`-format model end to end.*

**Phase 2 — Canonical IR + converters.** `Common*` types + all `from`/`to`
converters (unit-tested against fixtures).
*Exit: all converter pairs pass fixture tests.*

**Phase 3 — Full translation routing.** Wire `createBodyConverter` /
`createResponseConverter` / `createStreamPartConverter` into the router.
Support `oa-compat` (free + DeepSeek/GLM/Kimi), `openai` (GPT/Grok),
`google` (Gemini).
*Exit: each format family works end-to-end with a real model.*

**Phase 4 — Model registry & discovery.** Static snapshot + catalog fetch +
cache + alias-id `/v1/models` + `[1m]` variants + backend filtering.
*Exit: `/v1/models` shows only the active backend's models with alias ids.*

**Phase 5 — Capability detection.** Registry-driven capability table, strip
unsupported fields, optional live probes.
*Exit: unsupported capabilities never reach upstream.*

**Phase 6 — Hardening.** `count_tokens`, retries, timeouts, abort propagation,
cost pings, CORS, README with Claude Code setup, Dockerfile.
*Exit: full integration test suite green.*

---

## 16. Security & Robustness Notes

- **Secrets:** keys are read from env only; never logged. Redact
  `Authorization`/`x-api-key` in debug logs.
- **Free-tier privacy:** when backend is `free`, log a warning at startup that
  prompts may be retained/used for training (per OpenCode free-tier policy).
- **Cache file:** mode 0600; contains no secrets (model metadata only).
- **Timeouts:** upstream fetch bounded by `OPENCODE_REQUEST_TIMEOUT_MS`;
  client disconnect aborts upstream.
- **Retries:** only on transient network errors / 5xx; never on 4xx.
- **Header hygiene:** forward only whitelisted headers upstream (never forward
  `host`, `content-length` from client, or client auth headers — re-inject
  per format).

---

## Appendix A — Reference sources

- `anomalyco/opencode` (dev branch):
  `packages/console/app/src/routes/zen/util/{handler,provider/*,variant,error,modelsHandler}.ts`,
  `packages/console/core/src/model.ts` (ZenData catalog).
- `claude.md` — Claude Code client contract (headers, SSE, model picker, env).
- `endpoint.md` — OpenCode Zen/Go endpoints, formats, auth, discovery.
- `https://models.opencode.ai/catalog.json` — model metadata.
- `https://opencode.ai/docs/zen/`, `https://opencode.ai/docs/go/`.

## Appendix B — Claude Code client env (for README)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=<opencode-key>   # or ANTHROPIC_API_KEY
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
# optional hardening:
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_THINKING=1        # if backend rejects `thinking`
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
```