import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Hono } from "hono";
import type { Config } from "./config.js";
import { anthropicError, ProxyError } from "./errors.js";
import { registerHealth } from "./health.js";
import type { Logger } from "./logging.js";
import type { ModelRegistry } from "./modelRegistry.js";
import { handleCountTokens, handleMessages, handleModels, type RouterDeps } from "./router.js";

export interface ServerDeps {
  config: Config;
  logger: Logger;
  isReady: () => boolean;
  modelCount: () => number;
  registry: ModelRegistry;
}

/**
 * Build the hono app: CORS, health routes, `/v1/*` routes, error middleware,
 * not-found handler.
 */
export function createApp(deps: ServerDeps): Hono {
  const { config, logger } = deps;
  const app = new Hono();

  // No CORS headers on purpose. The clients are CLIs, which do not need them,
  // and this proxy has no authentication of its own: with `Access-Control-
  // Allow-Origin: *` any page in the user's browser could POST to
  // 127.0.0.1:8787 and spend the configured OpenCode key.

  registerHealth(app, deps);

  const routerDeps: RouterDeps = { config, logger, registry: deps.registry };

  // Anthropic Messages API surface (spec §3).
  app.post("/v1/messages", (c) => handleMessages(c, routerDeps));
  app.post("/v1/messages/count_tokens", (c) => handleCountTokens(c, routerDeps));
  app.get("/v1/models", (c) => handleModels(c, routerDeps));

  app.onError((err, c) => {
    if (err instanceof ProxyError) {
      logger.warn(`proxy error ${err.status}: ${err.message}`);
      return anthropicError(err.status, err.message, err.retryAfter);
    }
    logger.error("unhandled error", err);
    return anthropicError(500, "Internal server error");
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/v1/")) {
      return anthropicError(404, "Not found");
    }
    return c.json({ error: "Not found" }, 404);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Minimal node:http adapter (spec §2.1: hono on node:http, no deps beyond hono)
// ---------------------------------------------------------------------------

export interface ServeOptions {
  port: number;
  host: string;
  fetch: (request: Request) => Promise<Response> | Response;
}

/** Start a node:http server that feeds requests into a fetch handler. */
export function serve(opts: ServeOptions): Server {
  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const response = await opts.fetch(request);
      await writeResponse(res, response);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "error", message: "Internal server error" },
          }),
        );
      } else {
        res.end();
      }
    }
  });
  server.listen(opts.port, opts.host);
  return server;
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }
  return new Request(url, { method, headers, body });
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Client disconnected mid-stream: cancel the body so the underlying
        // stream's `cancel()` can abort the upstream fetch (spec §3.2/§9.2.6).
        if (res.destroyed) {
          await reader.cancel();
          return;
        }
        res.write(Buffer.from(value));
      }
    } catch (err) {
      // Writing to a closed socket throws — cancel upstream before rethrowing
      // so in-flight requests drain rather than leak.
      try {
        await reader.cancel();
      } catch {
        /* ignore secondary cancel errors */
      }
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}