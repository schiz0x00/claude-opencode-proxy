import { describe, expect, it } from "vitest";
import { clearAuth, extractApiKey } from "../src/auth.js";

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

describe("clearAuth", () => {
  it("removes every auth header", () => {
    const h = new Headers({ "x-api-key": "k", authorization: "Bearer k", "x-goog-api-key": "k" });
    clearAuth(h);
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-goog-api-key")).toBeNull();
  });
});
