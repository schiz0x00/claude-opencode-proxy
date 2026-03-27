import { describe, expect, it } from "vitest";
import { extractApiKey, injectAuth } from "../src/auth.js";

describe("extractApiKey", () => {
  it("reads x-api-key", () => {
    expect(extractApiKey(new Headers({ "x-api-key": "abc" }))).toBe("abc");
  });

  it("reads Authorization: Bearer", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer tok123" }))).toBe("tok123");
  });

  it("returns null when absent", () => {
    expect(extractApiKey(new Headers())).toBeNull();
  });

  it("returns null for non-Bearer authorization", () => {
    expect(extractApiKey(new Headers({ authorization: "Basic abc" }))).toBeNull();
  });
});

describe("injectAuth", () => {
  it("sets x-api-key for anthropic", () => {
    const h = new Headers();
    injectAuth(h, "anthropic", "k");
    expect(h.get("x-api-key")).toBe("k");
    expect(h.get("authorization")).toBeNull();
  });

  it("sets x-api-key for google", () => {
    const h = new Headers();
    injectAuth(h, "google", "k");
    expect(h.get("x-api-key")).toBe("k");
  });

  it("sets Bearer for oa-compat and openai", () => {
    for (const format of ["oa-compat", "openai"] as const) {
      const h = new Headers();
      injectAuth(h, format, "k");
      expect(h.get("authorization")).toBe("Bearer k");
      expect(h.get("x-api-key")).toBeNull();
    }
  });

  it("removes all auth headers when key is undefined", () => {
    const h = new Headers({ "x-api-key": "a", authorization: "Bearer b", "x-goog-api-key": "c" });
    injectAuth(h, "anthropic", undefined);
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-goog-api-key")).toBeNull();
  });
});