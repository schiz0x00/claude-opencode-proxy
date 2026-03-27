import { describe, expect, it } from "vitest";
import { pumpStream } from "../src/stream.js";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("pumpStream", () => {
  it("passes anthropic → anthropic through verbatim", async () => {
    const body = `event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const out = await collect(pumpStream({ upstream: sseResponse(body), upstreamFormat: "anthropic", clientFormat: "anthropic" }));
    expect(out).toBe(body);
  });

  it("does not duplicate message_stop when upstream sent it", async () => {
    const body = `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const out = await collect(pumpStream({ upstream: sseResponse(body), upstreamFormat: "anthropic", clientFormat: "anthropic" }));
    expect(out.match(/event: message_stop/g)).toHaveLength(1);
  });

  it("appends message_stop for non-anthropic upstreams", async () => {
    const body = `data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n`;
    const out = await collect(pumpStream({ upstream: sseResponse(body), upstreamFormat: "oa-compat", clientFormat: "anthropic" }));
    expect(out).toContain("message_stop");
  });

  it("consumes oa-compat [DONE] without forwarding it", async () => {
    const body = `data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`;
    const out = await collect(pumpStream({ upstream: sseResponse(body), upstreamFormat: "oa-compat", clientFormat: "anthropic" }));
    expect(out).not.toContain("[DONE]");
  });

  it("handles partial blocks split across chunks", async () => {
    const body = `event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        // Split mid-block.
        c.enqueue(enc.encode(body.slice(0, 30)));
        c.enqueue(enc.encode(body.slice(30)));
        c.close();
      },
    });
    const upstream = new Response(stream, { status: 200 });
    const out = await collect(pumpStream({ upstream, upstreamFormat: "anthropic", clientFormat: "anthropic" }));
    expect(out).toBe(body);
  });
});