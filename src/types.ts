/** Shared primitive types used across the proxy. */

export type Backend = "zen" | "go" | "free";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Capability flags describing what a model supports (spec §11.1). */
export interface Capabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  fileCompatibility: boolean;
  computerUse: boolean;
  audio: boolean;
  webSearch: boolean;
  embeddings: boolean;
}