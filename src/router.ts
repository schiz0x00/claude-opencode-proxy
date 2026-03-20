import type { Context } from "hono";
import { extractApiKey } from "./auth.js";
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

  const provider = getProvider(format, { model: modelId, providerModel: entry.id });

  // Translate the request body (identity for anthropic passthrough).
  let upstreamBody: any;
  try {
    upstreamBody = createBodyConverter("anthropic", format)(body);
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

  // Fetch upstream; timeout only bounds the initial response (streams are
  // kept alive by pings, spec §9.2).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
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
 * GET /v1/models (spec §4.3). Phase 1 stub: empty list so gateway model
 * discovery degrades gracefully; Phase 4 serves the full alias catalog.
 */
export async function handleModels(_c: Context, _deps: RouterDeps): Promise<Response> {
  return new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}