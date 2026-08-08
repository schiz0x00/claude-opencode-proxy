import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createRegistry } from "../src/modelRegistry.js";
import { createLogger } from "../src/logging.js";

const logger = createLogger("error");

function makeApp() {
  const registry = createRegistry("free");
  return createApp({
    config: {
      backend: "free",
      baseUrl: "http://127.0.0.1:1",
      port: 8787,
      host: "127.0.0.1",
      logLevel: "error",
      requestTimeoutMs: 5000,
      maxRetries: 0,
      modelCacheTtl: 86400,
      enableProbes: false,
      stripUnsupported: true,
      emitCostPings: false,
      modelCacheFile: "/tmp/models.json",
    } as never,
    logger,
    isReady: () => true,
    modelCount: () => registry.modelCount(),
    registry,
  });
}

describe("createApp", () => {
  it("sends no CORS headers, so browser pages cannot reach the proxy", async () => {
    const app = makeApp();
    // The proxy has no auth of its own and holds the OpenCode key; a wildcard
    // origin would let any open page spend it.
    const res = await app.request("/v1/models");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request("/v1/messages", { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves health endpoints", async () => {
    const app = makeApp();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
  });

  it("returns an anthropic error envelope for unknown /v1/* routes", async () => {
    const app = makeApp();
    const res = await app.request("/v1/nope");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("error");
  });

  it("returns a plain 404 for non-/v1 routes", async () => {
    const app = makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
describe("pumpStream error handling", () => {
  it("does not append message_stop after an oa-compat error envelope", async () => {
    const { pumpStream } = await import("../src/stream.js");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"error":{"message":"boom"}}\n\n'));
        c.close();
      },
    });
    const out = pumpStream({
      upstream: new Response(body),
      upstreamFormat: "oa-compat",
      clientFormat: "anthropic",
    });
    const text = await new Response(out).text();
    expect(text).toContain("boom");
    expect(text).not.toContain("message_stop");
  });
});

describe("pumpStream cancellation", () => {
  it("cancels a locked upstream body without throwing", async () => {
    const { pumpStream } = await import("../src/stream.js");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
        // Never closed: the client hangs up while upstream is still streaming.
      },
      cancel() {
        cancelled = true;
      },
    });
    const out = pumpStream({
      upstream: new Response(body),
      upstreamFormat: "oa-compat",
      clientFormat: "anthropic",
    });
    const reader = out.getReader();
    await reader.read();
    // start() holds a reader on the upstream body, so cancelling it through
    // `upstream.body.cancel()` would throw "ReadableStream is locked".
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });
});
