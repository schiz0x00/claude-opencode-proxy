/** Error types and the Anthropic error envelope (spec §12). */

export class ProxyError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface AnthropicErrorEnvelope {
  type: "error";
  error: { type: "error"; message: string };
}

/** Anthropic error envelope shape (spec §12.1) — both `type` fields set. */
export function anthropicErrorEnvelope(message: string): AnthropicErrorEnvelope {
  return { type: "error", error: { type: "error", message } };
}

/**
 * Build an Anthropic-envelope error Response (spec §12.1/§12.2). Sets
 * `retry-after` when provided.
 */
export function anthropicError(
  status: number,
  message: string,
  retryAfter?: number,
): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return new Response(JSON.stringify(anthropicErrorEnvelope(message)), {
    status,
    headers,
  });
}