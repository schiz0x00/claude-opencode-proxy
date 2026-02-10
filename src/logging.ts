import type { LogLevel } from "./types.js";

const RANKS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** Returns a logger that prefixes every line with `prefix`. */
  child(prefix: string): Logger;
}

/**
 * Leveled logger. Plain lines by default; JSON lines when `json` is true
 * (auto-enabled under `NODE_ENV=production`). Errors go to stderr.
 */
export function createLogger(level: LogLevel, json = process.env.NODE_ENV === "production"): Logger {
  const threshold = RANKS[level];
  const ts = () => new Date().toISOString();

  function make(prefix: string): Logger {
    function write(lvl: LogLevel, msg: string, args: unknown[]): void {
      if (RANKS[lvl] < threshold) return;
      const full = prefix ? `${prefix} ${msg}` : msg;
      if (json) {
        const line = JSON.stringify({
          time: ts(),
          level: lvl,
          msg: full,
          ...(args.length ? { args } : {}),
        });
        if (lvl === "error") process.stderr.write(line + "\n");
        else process.stdout.write(line + "\n");
      } else {
        const line = args.length ? `${full} ${args.map(formatArg).join(" ")}` : full;
        const out = `[${ts()}] ${lvl.toUpperCase().padEnd(5)} ${line}`;
        if (lvl === "error") process.stderr.write(out + "\n");
        else process.stdout.write(out + "\n");
      }
    }

    return {
      debug: (m, ...a) => write("debug", m, a),
      info: (m, ...a) => write("info", m, a),
      warn: (m, ...a) => write("warn", m, a),
      error: (m, ...a) => write("error", m, a),
      child: (p) => make(prefix ? `${prefix} ${p}` : p),
    };
  }

  return make("");
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Redact auth-bearing headers for debug logging (spec §16). Returns a plain
 * object with `authorization` and `x-api-key` values masked.
 */
export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "authorization" || k === "x-api-key") {
      out[key] = value ? "[redacted]" : "";
    } else {
      out[key] = value;
    }
  });
  return out;
}