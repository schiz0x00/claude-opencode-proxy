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

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }
      const splitter = createSseSplitter();
      let lastWrite = Date.now();
      let upstreamDone = false;
      let sawMessageStop = false;
      let sawError = false;

      const keepAlive = setInterval(() => {
        if (upstreamDone) return;
        if (Date.now() - lastWrite >= KEEP_ALIVE_MS) {
          controller.enqueue(encoder.encode(`event: ping\ndata: {"type":"ping"}\n\n`));
          lastWrite = Date.now();
        }
      }, KEEP_ALIVE_MS);

      const emit = (block: string): void => {
        if (!block) return;
        controller.enqueue(encoder.encode(block + "\n\n"));
        lastWrite = Date.now();
      };

      const processBlock = (block: string): void => {
        const ev = eventType(block);
        if (ev === "message_stop") sawMessageStop = true;
        // Mid-stream upstream error: forward verbatim and suppress the synthetic
        // `message_stop` so we close the stream as the spec requires (§9.2.3).
        if (ev === "error") sawError = true;
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
        controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
      }

      // Cost ping (spec §9.2.7): after the final chunk, from normalized usage.
      if (emitCostPings) {
        const usage = usageParser.retrieve();
        if (usage) {
          const normalized = getProvider(upstreamFormat, { model: "", providerModel: "" }).normalizeUsage(usage);
          controller.enqueue(
            encoder.encode(
              `event: ping\ndata: ${JSON.stringify({ type: "ping", cost: normalized })}\n\n`,
            ),
          );
        }
      }
      controller.close();
    },
    cancel() {
      upstream.body?.cancel();
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

function eventType(block: string): string {
  const m = block.match(/^event:\s*(\S+)/m);
  return m ? (m[1] ?? "message") : "message";
}