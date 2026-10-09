import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConnectTarget, resolveTarget } from "../src/masterserver/target.ts";
afterEach(() => vi.unstubAllGlobals());

describe("vanilla target grammar", () => {
  it.each(["r12345", "s12345", "q12345", "o12345", "x12345"])("routes %s with the same rule", (code) => {
    expect(parseConnectTarget(code)).toMatchObject({ host: `${code[0]}.relay.corrodinggames.com`,
      port: 5123, queryString: code });
  });
  it("preserves path text and parses only the host's port", () => {
    expect(parseConnectTarget("[TCP]host.example:6000/room:7000"))
      .toMatchObject({ host: "host.example", port: 6000, queryString: "room:7000" });
    expect(parseConnectTarget("example.com\\room:7000"))
      .toMatchObject({ host: "example.com", port: 5123, queryString: "room:7000" });
  });
  it("expands relay aliases and leaves short inputs as hosts", () => {
    expect(parseConnectTarget("asia.relay")).toMatchObject({ host: "asia.relay.corrodinggames.com", port: 5123 });
    expect(parseConnectTarget("1234")).toMatchObject({ host: "1234", port: 5123 });
  });
  it.each(["example.com:", "example.com:0", "example.com:65536", "example.com:1.5", "example.com:NaN"])
    ("rejects invalid port in %s", (input) => expect(() => parseConnectTarget(input)).toThrow(/port/i));
  it("requires a password before querying a password-protected descriptor", async () => {
    const fetch = vi.fn(() => { throw new Error("unexpected fetch"); });
    vi.stubGlobal("fetch", fetch);
    await expect(resolveTarget(parseConnectTarget("get|id|12345|true|5123"), null)).rejects.toThrow(/password/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
