import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "../src/modelRegistry.js";
import { handleModels } from "../src/router.js";
import { createLogger } from "../src/logging.js";

const logger = createLogger("error");

function makeDeps(backend: "zen" | "go" | "free") {
  return { registry: createRegistry(backend) };
}

describe("handleModels (GET /v1/models)", () => {
  it("serves alias ids with display names", async () => {
    const res = await handleModels({} as never, makeDeps("free"));
    const json = (await res.json()) as { object: string; data: Array<{ id: string; display_name: string }> };
    expect(res.status).toBe(200);
    expect(json.object).toBe("list");
    const row = json.data.find((m) => m.id === "claude-ocx-oa-compat--deepseek-v4-flash-free");
    expect(row?.display_name).toBe("DeepSeek V4 Flash (Free)");
  });

  it("adds [1m] variant rows for 1M-context models", async () => {
    const res = await handleModels({} as never, makeDeps("zen"));
    const json = (await res.json()) as { data: Array<{ id: string }> };
    const alias = "claude-ocx-anthropic--claude-sonnet-4-6";
    expect(json.data.some((m) => m.id === alias)).toBe(true);
    expect(json.data.some((m) => m.id === `${alias}[1m]`)).toBe(true);
  });

  it("only lists the active backend's models", async () => {
    const res = await handleModels({} as never, makeDeps("free"));
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.every((m) => m.id.includes("--"))).toBe(true);
    // free backend has no anthropic-format models
    expect(json.data.some((m) => m.id.includes("anthropic--"))).toBe(false);
  });
});

describe("registry refresh", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function tempCache(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "ocx-test-"));
    return path.join(dir, "models.json");
  }

  it("persists a cache file with mode 0600", async () => {
    const r = createRegistry("free");
    const cacheFile = await tempCache();
    await r.refresh({ baseUrl: "http://127.0.0.1:1", cacheFile, logger, timeoutMs: 200 });
    const stat = await import("node:fs/promises").then((fs) => fs.stat(cacheFile));
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(cacheFile, "utf8"));
    expect(parsed.backend).toBe("free");
    expect(parsed.models.length).toBeGreaterThan(0);
  });

  it("loads a valid cache on refresh (offline startup)", async () => {
    const r = createRegistry("free");
    const cacheFile = await tempCache();
    await r.refresh({ baseUrl: "http://127.0.0.1:1", cacheFile, logger, timeoutMs: 100 });
    const countAfterFirst = r.modelCount();

    // Second registry reads the cache even though the upstream is unreachable.
    const r2 = createRegistry("free");
    await r2.refresh({ baseUrl: "http://127.0.0.1:1", cacheFile, logger, timeoutMs: 100 });
    expect(r2.modelCount()).toBe(countAfterFirst);
  });

  it("merges live ids from the upstream /v1/models", async () => {
    const r = createRegistry("free");
    const cacheFile = await tempCache();
    // Point at a mock upstream that serves a live model list.
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url?.includes("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "brand-new-live-model" }, { id: "deepseek-v4-flash-free" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await r.refresh({ baseUrl: `http://127.0.0.1:${port}/v1`, cacheFile, logger, timeoutMs: 1000 });
      expect(r.resolveModel("brand-new-live-model")).toBeDefined();
      expect(r.resolveModel("deepseek-v4-flash-free")).toBeDefined();
    } finally {
      server.close();
    }
  });
});