import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { createRegistry } from "./modelRegistry.js";
import { createApp, serve } from "./server.js";
import { VERSION } from "./version.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

logger.info(`claude-opencode-proxy v${VERSION} starting`, {
  backend: config.backend,
  baseUrl: config.baseUrl,
  port: config.port,
  host: config.host,
});

if (config.backend === "free") {
  logger.warn(
    "free backend: prompts may be retained/used to improve models — do not send confidential data",
  );
}

// Model registry: static snapshot baseline + live discovery/cache (Phase 4).
const registry = createRegistry(config.backend);
logger.info(`loaded ${registry.modelCount()} models for backend ${config.backend}`);

// Readiness flips true once the model registry is loaded.
let ready = true;
const app = createApp({
  config,
  logger,
  isReady: () => ready,
  modelCount: () => registry.modelCount(),
  registry,
});

const server = serve({
  port: config.port,
  host: config.host,
  fetch: (req) => app.fetch(req),
});

ready = true;
logger.info(`listening on http://${config.host}:${config.port}`);

// Live model discovery: refresh at startup (non-blocking) and every TTL.
async function refreshModels(): Promise<void> {
  try {
    await registry.refresh({
      baseUrl: config.baseUrl,
      cacheFile: config.modelCacheFile,
      logger,
      maxCacheAgeSeconds: config.modelCacheTtl,
    });
  } catch (err) {
    logger.warn(`model refresh failed: ${(err as Error).message}`);
  }
}

void refreshModels();
// TTL 0 means "startup refresh only". Scheduling it would be setInterval(…, 0),
// which hammers the discovery and catalog endpoints in a tight loop.
const refreshTimer =
  config.modelCacheTtl > 0 ? setInterval(refreshModels, config.modelCacheTtl * 1000) : undefined;
refreshTimer?.unref();

function shutdown(signal: string): void {
  logger.info(`received ${signal}, shutting down`);
  if (refreshTimer) clearInterval(refreshTimer);
  server.close(() => process.exit(0));
  // Force-exit if in-flight requests refuse to drain.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));