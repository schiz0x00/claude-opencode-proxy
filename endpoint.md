# OpenCode Zen & Go — API Endpoints

Research compiled 2026-08-07 from opencode.ai docs (docs/zen, docs/go), Docker docs, and third-party review. Both Zen and Go are served by the same gateway: `opencode.ai`. One API key (from https://opencode.ai/auth) works for both. Keys work with **any** agent/tool — not just OpenCode (OpenAI-compatible and Anthropic-compatible formats).

## Auth

- Console / API key: https://opencode.ai/auth
- Sign in → add billing (Zen, pay-as-you-go) or subscribe to Go ($5 first month, then $10/mo).
- OpenCode TUI: run `/connect`, pick OpenCode Zen or OpenCode Go, paste key.

## Base URLs

| Service | Model list endpoint | Chat Completions (OpenAI) | Responses (OpenAI) | Messages (Anthropic) |
|---|---|---|---|---|
| **Zen** | `https://opencode.ai/zen/v1/models` | `https://opencode.ai/zen/v1/chat/completions` | `https://opencode.ai/zen/v1/responses` | `https://opencode.ai/zen/v1/messages` |
| **Go** | `https://opencode.ai/zen/go/v1/models` | `https://opencode.ai/zen/go/v1/chat/completions` | `https://opencode.ai/zen/go/v1/responses` | `https://opencode.ai/zen/go/v1/messages` |

Auth header: `Authorization: Bearer <API_KEY>`.

---

## Model list endpoint

OpenAI-style `/v1/models` list. **Public — no auth required** (verified 2026-08-07).

- Zen: `GET https://opencode.ai/zen/v1/models` → 61 models
- Go: `GET https://opencode.ai/zen/go/v1/models` → 25 models

Response shape:

```json
{
  "object": "list",
  "data": [
    {"id": "claude-sonnet-4-5", "object": "model", "created": 1786130896, "owned_by": "opencode"}
  ]
}
```

Live free models (Zen, `-free` suffix): `deepseek-v4-flash-free`, `mimo-v2.5-free`, `ling-3.0-flash-free`, `ling-3.0-tiny-free`, `nemotron-3-ultra-free`, `north-mini-code-free`, `laguna-s-2.1-free`, `longcat-2.0-free`, plus `big-pickle`. Note: `ling-3.0-flash-free` appears live but not in docs.

---

## How to determine which endpoint a model uses

**There is NO public API that exposes per-model endpoint/format.** Verified:

- `GET /v1/models` → bare ids only (`id`, `object`, `created`, `owned_by`). No format.
- `https://models.opencode.ai/catalog.json` → metadata (cost, limits, context, benchmarks) but **no format/endpoint field**.
- `https://models.opencode.ai/api.json` → provider catalog (upstream APIs), not Zen routing.

The mapping lives in the opencode source: `packages/console/core/src/model.ts` — the embedded `ZenData` catalog. Each model entry has a `format` (or `formatFilter` for multi-format entries) ∈ `anthropic | google | openai | oa-compat`. The docs tables (`zen.mdx`, `go.mdx`) are generated from this same catalog.

### Runtime routing (from source)

The gateway has 4 POST endpoints, each bound to one format:

| Endpoint | format | Auth header |
|---|---|---|
| `/v1/chat/completions` | `oa-compat` | `Authorization: Bearer` |
| `/v1/messages` | `anthropic` | `x-api-key` |
| `/v1/responses` | `openai` | `Authorization: Bearer` |
| `/v1/models/<id>` | `google` | `x-goog-api-key` |

`validateModel()`: if the model entry is an **array** (multi-format), it picks the variant matching the endpoint's `format` via `formatFilter`; if the model is a **scalar** entry, it is accepted on **any** endpoint and the gateway translates the body. So the docs' endpoint column is the *conventional* endpoint, not a hard restriction.

### Practical discovery

- **Free models**: `oa-compat` format, conventionally `/v1/chat/completions`. **Anonymous — no API key required** (verified live). The gateway also accepts them on `/v1/messages` and `/v1/responses` (translates), so a Claude-Code-style proxy can hit `/v1/messages` with a free model id directly.
- **Paid models**: auth check runs *before* format validation, so probing which endpoint a model accepts requires a valid key. With a key, POST a minimal body to each endpoint — wrong format returns `modelFormatNotSupported`-style error, right format proceeds.
- **Ground truth**: docs tables (https://opencode.ai/docs/zen/, /docs/go/) or the `ZenData` catalog in the opencode repo.

---

## Zen — OpenAI-compatible endpoints

### Chat Completions — `https://opencode.ai/zen/v1/chat/completions`

Serves (model id → config id `opencode/<id>`):

- DeepSeek: `deepseek-v4-pro`, `deepseek-v4-flash`
- GLM: `glm-5.2`, `glm-5.1`, `glm-5`
- Kimi: `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`
- MiniMax: `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`
- **Free models** (all use this endpoint): `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `laguna-s-2.1-free`, `ling-3.0-tiny-free`, `longcat-2.0-free`, `north-mini-code-free`, `nemotron-3-ultra-free`

### Responses API — `https://opencode.ai/zen/v1/responses`

- GPT family: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-5-nano`
- Grok: `grok-4.5`, `grok-build-0.1`

### Google — `https://opencode.ai/zen/v1/models/<model-id>`

Per-model path (Gemini SDK):
- `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash`

## Zen — Anthropic-compatible endpoint

### Messages — `https://opencode.ai/zen/v1/messages`

- Claude: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- Qwen: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus`
- MiniMax: `minimax-m3`, `minimax-m2.7`

---

## Go — endpoints

Go model list: `https://opencode.ai/zen/go/v1/models`. Config id format: `opencode-go/<model-id>`.

### Chat Completions — `https://opencode.ai/zen/go/v1/chat/completions`

- `grok-4.5`, `glm-5.2`, `glm-5.1`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`, `mimo-v2.5`, `mimo-v2.5-pro`, `hy3`

### Responses — `https://opencode.ai/zen/go/v1/responses`

- `gpt-5.6-luna`

### Messages (Anthropic) — `https://opencode.ai/zen/go/v1/messages`

- `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `qwen3.8-max`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`

### Go usage limits

- $12 of usage per rolling 5 hours
- $30 per week
- $60 per month
- At limit: falls back to **free models** automatically; or enable "Use balance" to draw from Zen credits.
- One member per workspace can subscribe.

---

## Free models (Zen)

Available at no cost. All OpenAI-compatible Chat Completions (`/v1/chat/completions`). Limited-time preview — team collecting feedback.

| Model | id |
|---|---|
| Big Pickle | `big-pickle` |
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` |
| MiMo-V2.5 Free | `mimo-v2.5-free` |
| Laguna S 2.1 Free | `laguna-s-2.1-free` |
| Ling-3.0-tiny Free | `ling-3.0-tiny-free` |
| Ling-3.0-flash Free | `ling-3.0-flash-free` |
| LongCat-2.0 Free | `longcat-2.0-free` |
| North Mini Code Free | `north-mini-code-free` |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` |

Privacy caveat: during free period, prompts may be retained/used to improve the model (Big Pickle, DeepSeek V4 Flash Free, MiMo-V2.5 Free, Laguna S 2.1 Free, Ling-3.0-tiny Free, Ling-3.0-flash Free, LongCat-2.0 Free, North Mini Code Free, Nemotron 3 Ultra Free). Do not send confidential data to free models. Paid models: zero-retention for most; exceptions per the Go docs privacy table — Grok 4.5 and GPT 5.6 Luna retain data for 30 days.

---

## Example usage

OpenAI-compatible chat:

```bash
curl https://opencode.ai/zen/v1/chat/completions \
  -H "Authorization: Bearer $OPCODE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

Anthropic-compatible messages:

```bash
curl https://opencode.ai/zen/v1/messages \
  -H "Authorization: Bearer $OPCODE_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

OpenAI Responses:

```bash
curl https://opencode.ai/zen/v1/responses \
  -H "Authorization: Bearer $OPCODE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.6-luna", "input": "hi"}'
```

## Notes for Claude Code / proxy

- Anthropic-compatible path is `/v1/messages` → set `ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1` (or `/zen/go/v1`), model ids as above.
- OpenAI-compatible path is `/v1/chat/completions` → base `https://opencode.ai/zen/v1` (or `/zen/go/v1`).
- `/responses` is OpenAI Responses API — NOT the classic chat completions shape; use `@ai-sdk/openai` or OpenAI Responses clients.
- Free fallback for Go when limit hit: `deepseek-v4-flash-free` etc. still on `/zen/v1/chat/completions`.

Sources: https://opencode.ai/docs/zen/ · https://opencode.ai/docs/go/ · https://docs.docker.com/ai/docker-agent/providers/opencode-zen/ · https://thomas-wiegold.com/blog/opencode-go-review/
