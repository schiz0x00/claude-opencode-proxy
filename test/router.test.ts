import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logging.js";
import { createRegistry } from "../src/modelRegistry.js";
import { handleMessages } from "../src/router.js";

const logger = createLogger("error");

function mockContext(body: unknown): never {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    },
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

function makeDeps(baseUrl: string) {
  return {
    config: {
      backend: "free",
      baseUrl,
      zenApiKey: undefined,
      goApiKey: undefined,
      stripUnsupported: true,
      emitCostPings: false,
      requestTimeoutMs: 5000,
      maxRetries: 0,
      modelCacheTtl: 86400,
      modelCacheFile: "/tmp/models.json",
      port: 8787,
      host: "127.0.0.1",
      logLevel: "error",
      enableProbes: false,
    } as never,
    logger,
    registry: createRegistry("free"),
  };
}

describe("handleMessages provider body modification", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it("adds stream_options.include_usage to streaming oa-compat requests (modifyBody wired)", async () => {
    let captured: { url: string; body: unknown } | undefined;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured = { url: req.url ?? "", body: JSON.parse(body || "{}") };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

    const deps = makeDeps(`http://127.0.0.1:${port}/v1`);
    const res = await handleMessages(
      mockContext({
        model: "deepseek-v4-flash-free",
        stream: true,
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    // Consume the stream body so the response settles.
    await res.text();

    expect(captured?.url).toBe("/v1/chat/completions");
    const sent = captured?.body as { stream_options?: { include_usage?: boolean } };
    expect(sent.stream_options?.include_usage).toBe(true);
  });
});
