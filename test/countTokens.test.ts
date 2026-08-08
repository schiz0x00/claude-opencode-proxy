import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "../src/modelRegistry.js";
import { handleCountTokens } from "../src/router.js";
import { createLogger } from "../src/logging.js";

const logger = createLogger("error");

function makeDeps(backend: "zen" | "go" | "free", baseUrl: string) {
  return {
    config: {
      backend,
      baseUrl,
      zenApiKey: "zen-key",
      goApiKey: undefined,
      stripUnsupported: true,
      emitCostPings: false,
      requestTimeoutMs: 5000,
      maxRetries: 0,
    } as never,
    logger,
    registry: createRegistry(backend),
  };
}

function mockContext(body: unknown): never {
  const req = new Request("http://localhost/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    req: {
      header: (n: string) => req.headers.get(n),
      raw: req,
      json: async () => body,
    },
  } as never;
}

describe("handleCountTokens (POST /v1/messages/count_tokens)", () => {
  it("returns a local estimate for non-anthropic models", async () => {
    const deps = makeDeps("free", "http://127.0.0.1:1");
    const res = await handleCountTokens(
      mockContext({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hello world" }] }),
      deps,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens: number; output_tokens: number };
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(json.input_tokens).toBe(3);
    expect(json.output_tokens).toBe(0);
  });

  it("counts system + messages text", async () => {
    const deps = makeDeps("free", "http://127.0.0.1:1");
    const res = await handleCountTokens(
      mockContext({
        model: "deepseek-v4-flash-free",
        system: "abcdefgh",
        messages: [{ role: "user", content: "1234" }],
      }),
      deps,
    );
    const json = (await res.json()) as { input_tokens: number };
    // 8 + 4 = 12 chars → ceil(12/4) = 3
    expect(json.input_tokens).toBe(3);
  });

  it("falls back to a local estimate when the upstream is unreachable", async () => {
    const deps = makeDeps("zen", "http://127.0.0.1:1");
    const res = await handleCountTokens(
      mockContext({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens: number };
    expect(json.input_tokens).toBe(1);
  });

  it("forwards to the upstream count_tokens endpoint for anthropic models", async () => {
    let received: { url: string; body: unknown } | undefined;
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = { url: req.url ?? "", body: JSON.parse(body || "{}") };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 42, output_tokens: 0 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    try {
      const deps = makeDeps("zen", `http://127.0.0.1:${port}/v1`);
      const res = await handleCountTokens(
        mockContext({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
        }),
        deps,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { input_tokens: number };
      expect(json.input_tokens).toBe(42);
      expect(received?.url).toBe("/v1/messages/count_tokens");
      expect((received?.body as { model: string }).model).toBe("claude-sonnet-4-6");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
describe("local estimate", () => {
  it("counts tool_result payloads", async () => {
    const deps = makeDeps("free", "http://127.0.0.1:1/v1");
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "x".repeat(400) },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "y".repeat(400) }] },
          ],
        },
      ],
    };
    const res = await handleCountTokens(mockContext(body), deps);
    const json = (await res.json()) as { input_tokens: number };
    // 800 chars / 4 — previously 0, because tool_result nests under `content`.
    expect(json.input_tokens).toBe(200);
  });
});
