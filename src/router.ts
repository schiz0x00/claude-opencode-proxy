import type { Context } from "hono";
import { extractApiKey } from "./auth.js";
import { applyReasoningEffort, stripUnsupported } from "./capability.js";
import type { Config } from "./config.js";
import { ProxyError } from "./errors.js";
import type { Logger } from "./logging.js";
import type { ModelRegistry } from "./modelRegistry.js";
import { pumpStream } from "./stream.js";
import {
  createBodyConverter,
  createResponseConverter,
  getProvider,
} from "./translate/provider.js";

export interface RouterDeps {
  config: Config;
  logger: Logger;
  registry: ModelRegistry;
}

/** Client headers forwarded to the upstream (spec §3.1). */
const FORWARD_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
  "anthropic-workspace-id",
  "content-type",
];

/**
 * POST /v1/messages (spec §3.1). Parse → resolve model → translate body →
 * build upstream headers → fetch → stream (or non-stream) back to the client.
 */
export async function handleMessages(c: Context, deps: RouterDeps): Promise<Response> {
  const { config, logger, registry } = deps;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new ProxyError(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object") throw new ProxyError(400, "Invalid request body");

  const modelId = typeof body.model === "string" ? body.model : "";
  if (!modelId) throw new ProxyError(400, "Missing model");

  const resolved = registry.resolveModel(modelId);
  if (!resolved) throw new ProxyError(404, `Unknown model: ${modelId}`);

  const entry = resolved.entry;
  const format = entry.format;
  const isStream = body.stream === true;

  const provider = getProvider(format, {
    model: modelId,
    providerModel: entry.id,
    supports1m: entry.contextWindow >= 1_000_000 || resolved.contextVariant === "1m",
  });

  // Captured before stripping: the anthropic `thinking` block is the only
  // place Claude Code states reasoning effort, and it is translated away.
  const thinking = body.thinking;

  // Strip capabilities the model doesn't support (spec §11.2) before
  // translating, so unsupported fields never reach the backend.
  if (config.stripUnsupported) {
    stripUnsupported(body, entry.capabilities, logger);
  }

  // Translate the request body (identity for anthropic passthrough), then apply
  // any provider-specific body tweaks (e.g. oa-compat `stream_options.include_usage`
  // on streaming requests so the upstream returns the final usage chunk).
  let upstreamBody: any;
  try {
    upstreamBody = createBodyConverter("anthropic", format)(body);
    // The client may have asked by alias id (`claude-ocx-<format>--<model>`,
    // served by GET /v1/models for gateway model discovery) or by a `[1m]`
    // variant. Neither exists upstream — always send the real OpenCode id.
    upstreamBody.model = entry.id;
    // Anthropic upstreams already speak `thinking` natively (identity
    // conversion); everything else needs the catalog-advertised knob.
    if (format !== "anthropic" && entry.capabilities.reasoning) {
      applyReasoningEffort(upstreamBody, thinking, entry.reasoningOptions);
    }
    upstreamBody = provider.modifyBody(upstreamBody);
  } catch (err) {
    throw new ProxyError(501, (err as Error).message);
  }

  // Auth: client key wins, else configured key; free backend sends none.
  const clientKey = extractApiKey(c.req.raw.headers);
  const apiKey =
    config.backend === "free"
      ? undefined
      : (clientKey ?? config.zenApiKey ?? config.goApiKey);

  // Build upstream headers: forward whitelist, then provider-specific.
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = c.req.header(name);
    if (v) headers.set(name, v);
  }
  const stickyId = c.req.header("x-claude-code-session-id") ?? "";
  provider.modifyHeaders(headers, apiKey ?? "", stickyId);
  if (apiKey === undefined) {
    headers.delete("x-api-key");
    headers.delete("authorization");
    headers.delete("x-goog-api-key");
  }

  const url = provider.modifyUrl(config.baseUrl, isStream);

  // Fetch upstream with retries (spec §12): retry only transient network
  // errors and 5xx/429, never 4xx; timeout bounds the initial response
  // (streams are kept alive by pings, spec §9.2).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let upstream: Response;
  try {
    upstream = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
      maxRetries: config.maxRetries,
      logger,
    });
  } catch (err) {
    throw new ProxyError(502, `Upstream request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  // Non-2xx: forward the upstream error body verbatim (spec §9.2) so Claude
  // Code's retry/feature-disable logic can match on the wording.
  if (!upstream.ok) {
    const bodyText = await upstream.text();
    logger.warn(`upstream ${upstream.status} for model ${modelId}`);
    return new Response(bodyText, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  if (isStream) {
    const stream = pumpStream({
      upstream,
      upstreamFormat: format,
      clientFormat: "anthropic",
      emitCostPings: config.emitCostPings,
      onError: (err) => logger.error("stream error", err),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  // Non-streaming fallback.
  const json = await upstream.json();
  let converted: any;
  try {
    converted = createResponseConverter(format, "anthropic")(json);
  } catch (err) {
    throw new ProxyError(501, (err as Error).message);
  }
  return new Response(JSON.stringify(converted), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * POST /v1/messages/count_tokens (spec §5.2). For anthropic-format models,
 * forward to the upstream count_tokens endpoint; otherwise return a local
 * estimate (`ceil(chars / 4)` over system + messages). Claude Code falls
 * back to its own estimate if this 404s, so failure is non-fatal.
 */
export async function handleCountTokens(c: Context, deps: RouterDeps): Promise<Response> {
  const { config, logger, registry } = deps;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new ProxyError(400, "Invalid JSON body");
  }
  const modelId = typeof body?.model === "string" ? body.model : "";
  const resolved = modelId ? registry.resolveModel(modelId) : undefined;

  // Anthropic-format models can use the upstream count_tokens endpoint.
  if (resolved && resolved.entry.format === "anthropic") {
    const clientKey = extractApiKey(c.req.raw.headers);
    const apiKey =
      config.backend === "free" ? undefined : (clientKey ?? config.zenApiKey ?? config.goApiKey);
    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const v = c.req.header(name);
      if (v) headers.set(name, v);
    }
    const provider = getProvider("anthropic", {
      model: modelId,
      providerModel: resolved.entry.id,
      supports1m: resolved.entry.contextWindow >= 1_000_000 || resolved.contextVariant === "1m",
    });
    provider.modifyHeaders(headers, apiKey ?? "", "");
    if (apiKey === undefined) {
      headers.delete("x-api-key");
      headers.delete("authorization");
      headers.delete("x-goog-api-key");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      // Base URL already carries `/v1` (reference pattern); append the
      // endpoint suffix without it. Retries honor OPENCODE_MAX_RETRIES; the
      // timeout bounds the whole attempt (§12, §16).
      const upstream = await fetchWithRetry(`${config.baseUrl}/messages/count_tokens`, {
        method: "POST",
        headers,
        // Same alias rewrite as /v1/messages — upstream only knows real ids.
        body: JSON.stringify({ ...body, model: resolved.entry.id }),
        signal: controller.signal,
        maxRetries: config.maxRetries,
        logger,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      logger.warn(`count_tokens upstream failed: ${(err as Error).message}`);
      return localEstimate(body);
    } finally {
      clearTimeout(timeout);
    }
  }

  return localEstimate(body);
}

/** Local token estimate: ceil(chars / 4) over system + messages (spec §5.2). */
function localEstimate(body: any): Response {
  let chars = 0;
  const countText = (s: unknown): void => {
    if (typeof s === "string") chars += s.length;
    else if (Array.isArray(s)) for (const item of s) countText(item);
    else if (s && typeof s === "object") {
      const obj = s as Record<string, unknown>;
      // Anthropic content blocks carry text in `text`; tool_use inputs are
      // JSON — count their serialized length too.
      if (typeof obj.text === "string") chars += obj.text.length;
      else if (obj.input && typeof obj.input === "object") {
        chars += JSON.stringify(obj.input).length;
      }
    }
  };
  countText(body?.system);
  for (const m of body?.messages ?? []) {
    if (m && typeof m === "object") countText((m as Record<string, unknown>).content);
  }
  return new Response(
    JSON.stringify({ input_tokens: Math.ceil(chars / 4), output_tokens: 0 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * GET /v1/models (spec §4.3, §5.1). Serves the active backend's models as
 * Anthropic-native alias ids (`claude-ocx-<format>--<model>`) so gateway
 * model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) can
 * populate Claude Code's `/model` picker. Models with a 1M context window
 * get an extra `[1m]` variant row.
 */
export async function handleModels(_c: Context, deps: RouterDeps): Promise<Response> {
  const { registry } = deps;
  const created = Math.floor(Date.now() / 1000);
  const data: Array<Record<string, unknown>> = [];
  for (const entry of registry.getBackendModels()) {
    const alias = registry.toAliasId(entry);
    const row = {
      id: alias,
      object: "model",
      created,
      owned_by: "opencode",
      display_name: entry.displayName ?? entry.id,
    };
    data.push(row);
    if (entry.contextWindow >= 1_000_000) {
      data.push({ ...row, id: `${alias}[1m]` });
    }
  }
  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface FetchWithRetryOptions {
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
  maxRetries: number;
  logger: Logger;
}

/**
 * fetch() with retries (spec §12). Retries only transient network errors and
 * 5xx/429 responses — never 4xx. Uses short exponential backoff; the caller's
 * AbortSignal still bounds the whole attempt.
 */
async function fetchWithRetry(
  url: string,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  const { maxRetries, logger } = opts;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal,
      });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      // Transient upstream failure: drain the body so the socket can be reused.
      await res.text().catch(() => undefined);
      if (attempt >= maxRetries) return res;
      logger.warn(`upstream ${res.status}, retrying (${attempt + 1}/${maxRetries})`);
    } catch (err) {
      lastErr = err as Error;
      if (opts.signal.aborted) throw err;
      if (attempt >= maxRetries) throw err;
      logger.warn(`upstream network error, retrying (${attempt + 1}/${maxRetries}): ${lastErr.message}`);
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
  throw lastErr ?? new Error("fetch failed");
}