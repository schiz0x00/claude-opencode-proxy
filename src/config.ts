import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolveBackend, resolveBaseUrl } from "./backend.js";
import type { Backend, LogLevel } from "./types.js";

export interface Config {
  backend: Backend;
  zenApiKey?: string;
  goApiKey?: string;
  /** Resolved upstream base URL (no trailing slash). */
  baseUrl: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  requestTimeoutMs: number;
  maxRetries: number;
  modelCacheTtl: number;
  enableProbes: boolean;
  stripUnsupported: boolean;
  emitCostPings: boolean;
  modelCacheFile: string;
}

const DEFAULT_MODEL_CACHE_FILE = "~/.claude-opencode-proxy/models.json";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveIntSchema = z.coerce.number().int().min(1);
const nonNegIntSchema = z.coerce.number().int().min(0);
const boolSchema = z
  .union([z.literal("true"), z.literal("false")])
  .transform((v) => v === "true");

function parseOptional<T>(
  schema: z.ZodType<T>,
  raw: string | undefined,
  name: string,
  issues: string[],
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  issues.push(`${name}: ${res.error.issues.map((i) => i.message).join("; ")}`);
  return undefined;
}

/**
 * Parse env per spec §4.1, validate with zod, and return a frozen `Config`.
 * Throws with a message listing every offending variable on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const issues: string[] = [];

  const backend = resolveBackend(env);

  const port =
    parseOptional(portSchema, env.OPENCODE_PORT, "OPENCODE_PORT", issues) ?? 8787;
  const logLevel =
    parseOptional(logLevelSchema, env.OPENCODE_LOG_LEVEL, "OPENCODE_LOG_LEVEL", issues) ??
    "info";
  const requestTimeoutMs =
    parseOptional(
      positiveIntSchema,
      env.OPENCODE_REQUEST_TIMEOUT_MS,
      "OPENCODE_REQUEST_TIMEOUT_MS",
      issues,
    ) ?? 600_000;
  const maxRetries =
    parseOptional(
      nonNegIntSchema,
      env.OPENCODE_MAX_RETRIES,
      "OPENCODE_MAX_RETRIES",
      issues,
    ) ?? 2;
  const modelCacheTtl =
    parseOptional(
      nonNegIntSchema,
      env.OPENCODE_MODEL_CACHE_TTL,
      "OPENCODE_MODEL_CACHE_TTL",
      issues,
    ) ?? 86_400;
  const enableProbes =
    parseOptional(boolSchema, env.OPENCODE_ENABLE_PROBES, "OPENCODE_ENABLE_PROBES", issues) ??
    false;
  const stripUnsupported =
    parseOptional(
      boolSchema,
      env.OPENCODE_STRIP_UNSUPPORTED,
      "OPENCODE_STRIP_UNSUPPORTED",
      issues,
    ) ?? true;
  const emitCostPings =
    parseOptional(
      boolSchema,
      env.OPENCODE_EMIT_COST_PINGS,
      "OPENCODE_EMIT_COST_PINGS",
      issues,
    ) ?? false;

  if (issues.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
  }

  const config: Config = {
    backend,
    zenApiKey: env.OPENCODE_ZEN_API_KEY || undefined,
    goApiKey: env.OPENCODE_GO_API_KEY || undefined,
    baseUrl: resolveBaseUrl(backend, env.OPENCODE_BASE_URL),
    port,
    host: env.OPENCODE_HOST ?? "127.0.0.1",
    logLevel,
    requestTimeoutMs,
    maxRetries,
    modelCacheTtl,
    enableProbes,
    stripUnsupported,
    emitCostPings,
    modelCacheFile: expandHome(env.OPENCODE_MODEL_CACHE_FILE ?? DEFAULT_MODEL_CACHE_FILE),
  };

  return Object.freeze(config);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}