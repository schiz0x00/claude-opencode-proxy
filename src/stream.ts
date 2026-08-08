import { createStreamPartConverter, getProvider } from "./translate/provider.js";
import type { Format } from "./translate/types.js";

export interface PumpOptions {
  upstream: Response;
  upstreamFormat: Format;
  clientFormat: Format;
  emitCostPings?: boolean;
  onError?: (err: Error) => void;
}

const KEEP_ALIVE_MS = 30_000;

/**
 * Pump an upstream SSE body to the client (spec §9). Always streams; emits a
 * keep-alive `ping` every 30 s when silent; forwards upstream errors verbatim;
 * terminates with `message_stop` for anthropic clients (consuming oa-compat's
 * `[DONE]`). Returns a client-facing ReadableStream.
 */
export function pumpStream(opts: PumpOptions): ReadableStream<Uint8Array> {
  const { upstream, upstreamFormat, clientFormat, emitCostPings, onError } = opts;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const convert = createStreamPartConverter(upstreamFormat, clientFormat);
  const sameFormat = upstreamFormat === clientFormat;
  const usageParser = getProvider(upstreamFormat, { model: "", providerModel: "" }).createUsageParser();

  // Latched by cancel() (client hung up) and by the first failed enqueue, so
  // both start() and the keep-alive timer can see it.
  let closed = false;
  // Held for cancel(): start() locks the upstream body, and cancelling a
  // locked stream throws. The reader is the only handle that can release it.
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body?.getReader();
      upstreamReader = reader;
      if (!reader) {
        controller.close();
        return;
      }
      const splitter = createSseSplitter();
      let lastWrite = Date.now();
      let upstreamDone = false;
      let sawMessageStop = false;
      let sawError = false;

      // A cancelled stream (client hung up) closes the controller while the
      // read loop is still awaiting upstream, so every enqueue after that
      // point throws. Inside the interval callback that throw is uncaught and
      // takes the process down, so all writes go through this guard.
      const write = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        } catch {
          closed = true;
        }
      };

      const keepAlive = setInterval(() => {
        if (upstreamDone || closed) return;
        if (Date.now() - lastWrite >= KEEP_ALIVE_MS) {
          write(`event: ping\ndata: {"type":"ping"}\n\n`);
        }
      }, KEEP_ALIVE_MS);

      const emit = (block: string): void => {
        if (!block) return;
        write(block + "\n\n");
      };

      const processBlock = (block: string): void => {
        const ev = eventType(block);
        if (ev === "message_stop") sawMessageStop = true;
        // Mid-stream upstream error: forward verbatim and suppress the synthetic
        // `message_stop` so we close the stream as the spec requires (§9.2.3).
        // oa-compat upstreams have no event line — they just send an error
        // envelope as data, so the payload has to be inspected too.
        if (ev === "error" || isErrorPayload(block)) sawError = true;
        if (upstreamFormat === "oa-compat" && block.trim() === "data: [DONE]") return;
        usageParser.parse(block);
        if (sameFormat) {
          emit(block);
          return;
        }
        const out = convert(block);
        emit(out);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const block of splitter.push(text)) processBlock(block);
        }
        upstreamDone = true;
        for (const block of splitter.flush()) processBlock(block);
      } catch (err) {
        onError?.(err as Error);
      } finally {
        clearInterval(keepAlive);
      }

      if (clientFormat === "anthropic" && !sawMessageStop && !sawError) {
        write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      }

      // Cost ping (spec §9.2.7): after the final chunk, from normalized usage.
      if (emitCostPings) {
        const usage = usageParser.retrieve();
        if (usage) {
          const normalized = getProvider(upstreamFormat, { model: "", providerModel: "" }).normalizeUsage(usage);
          write(`event: ping\ndata: ${JSON.stringify({ type: "ping", cost: normalized })}\n\n`);
        }
      }
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
      // Abort the upstream fetch so it does not keep streaming into nothing.
      // This runs inside a stream callback, where a throw is fatal, and both
      // calls can reject on an already-finished body.
      const pending = upstreamReader ? upstreamReader.cancel() : upstream.body?.cancel();
      void Promise.resolve(pending).catch(() => undefined);
    },
  });
}

/** Line-based SSE splitter: buffers partial blocks, emits complete ones. */
function createSseSplitter(): { push: (text: string) => string[]; flush: () => string[] } {
  let buffer = "";
  return {
    push(text: string): string[] {
      buffer += text.replace(/\r\n/g, "\n");
      const blocks: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        blocks.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      return blocks;
    },
    flush(): string[] {
      const blocks = buffer ? [buffer] : [];
      buffer = "";
      return blocks;
    },
  };
}

/** True when an SSE block's data payload is an error envelope. */
function isErrorPayload(block: string): boolean {
  const line = block.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return false;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]" || !payload.startsWith("{")) return false;
  try {
    const json = JSON.parse(payload) as { error?: unknown };
    return json?.error !== undefined && json.error !== null;
  } catch {
    return false;
  }
}

function eventType(block: string): string {
  const m = block.match(/^event:\s*(\S+)/m);
  return m ? (m[1] ?? "message") : "message";
}