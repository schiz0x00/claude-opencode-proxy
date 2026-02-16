import type { Hono } from "hono";
import type { Config } from "./config.js";
import { VERSION } from "./version.js";

export interface HealthDeps {
  config: Config;
  isReady: () => boolean;
  modelCount: () => number;
}

/** Register liveness/readiness/info routes (spec §5, §13.12). */
export function registerHealth(app: Hono, deps: HealthDeps): void {
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/ready", (c) => {
    if (deps.isReady()) return c.json({ status: "ready" });
    return c.json({ status: "not-ready" }, 503);
  });

  app.get("/", (c) =>
    c.json({
      name: "claude-opencode-proxy",
      version: VERSION,
      backend: deps.config.backend,
      modelCount: deps.modelCount(),
    }),
  );
}