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
  it("answers CORS preflight with 204 and allow headers", async () => {
    const app = makeApp();
    const res = await app.request("/v1/messages", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("adds CORS headers to normal responses", async () => {
    const app = makeApp();
    const res = await app.request("/v1/models");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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