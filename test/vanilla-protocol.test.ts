import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRegister } from "../src/protocol/packets/common.ts";
import { repeatHash } from "../src/protocol/hashes.ts";
import { ByteReader, ByteWriter } from "../src/protocol/primitives.ts";
import { parsePowChallenge, solvePowChallenge } from "../src/protocol/packets/pow.ts";
import { parseRelayRedirect } from "../src/client/session.ts";
import { integrityString } from "../src/protocol/integrity.ts";
import { vi } from "vitest";

// Wire rules: rw_analysis/02b-decompiled/.../j/ad.java and gameFramework/f.java.
const upperHash = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase();

describe("vanilla registration hashes", () => {
  it("sends uppercase password and per-server identity hashes", () => {
    const r = new ByteReader(buildRegister({ playerName: "audit", networkVersion: 176,
      password: "test-password", clientUuid: "audit-seed", serverUuid: "audit-server" }));
    r.readUTF(); r.readInt(); r.readInt(); r.readInt(); r.readUTF();
    expect(r.readNullableString()).toBe("C638833F69BBFB3C267AFA0A74434812436B8F08A81FD263C6BE6871DE4F1265");
    r.readUTF();
    expect(r.readUTF()).toBe(upperHash("audit-seedaudit-server"));
    expect(r.readInt()).toBe(678359601);
  });

  it("hashes uppercase intermediate strings for master-server p_hash", () => {
    expect(repeatHash("audit-roomtest-password", 3))
      .toBe("A1F76F81A058A63BECBD2EC1114F8213EEDEA326F4051583CA6D09337B176BF7");
  });
});

describe("vanilla 178 binary reconnect packet", () => {
  it("reads Java UTF address boundaries and preserves opaque query text", () => {
    const payload = new ByteWriter().writeByte(0).writeInt(42).writeBoolean(true).writeInt(3)
      .writeUTF("example.com").writeUTF("r12345").writeUTF("[TCP]host.example:6000/房间:7000").toBuffer();
    expect(parseRelayRedirect(payload)).toEqual({
      formatVersion: 0, reconnectId: 42, showFailure: true,
      addresses: ["example.com", "r12345", "[TCP]host.example:6000/房间:7000"],
    });
  });

  it.each([-1, 10000])("rejects invalid address count %i", (count) => {
    const payload = new ByteWriter().writeByte(0).writeInt(0).writeBoolean(false).writeInt(count).toBuffer();
    expect(() => parseRelayRedirect(payload)).toThrow();
  });

  it("rejects truncated strings instead of scanning incidental text", () => {
    const payload = new ByteWriter().writeByte(0).writeInt(0).writeBoolean(false).writeInt(1)
      .writeUTF("[TCP]example.com:5123").toBuffer();
    expect(() => parseRelayRedirect(payload.subarray(0, -1))).toThrow();
  });
});

describe("vanilla stateful 151 challenge", () => {
  it("keeps the original integrity formula independent of RWX environment flags", () => {
    vi.stubEnv("INTEGRITY_RWX_VARIANT", "1");
    try { expect(integrityString(12345)).toContain("7:746163520"); }
    finally { vi.unstubAllEnvs(); }
  });
  it("uses initial challenge values 55 and 66 when fields are absent", () => {
    for (const [type, answer] of [[0, "55"], [1, "66"]] as const) {
      const payload = new ByteWriter().writeInt(1).writeInt(type).writeBoolean(false).writeBoolean(false).toBuffer();
      expect(solvePowChallenge(parsePowChallenge(payload))).toBe(answer);
    }
  });

  it("retains supplied parameters across later challenges, including type 6", () => {
    const state = { minClientVersion: 55, minServerVersion: 66 };
    const parse = parsePowChallenge as (payload: Buffer, state: { minClientVersion: number; minServerVersion: number }) => ReturnType<typeof parsePowChallenge>;
    parse(new ByteWriter().writeInt(1).writeInt(0).writeBoolean(true).writeInt(123)
      .writeBoolean(true).writeInt(456).toBuffer(), state);
    const c = parse(new ByteWriter().writeInt(2).writeInt(6).writeBoolean(false).writeBoolean(false)
      .writeUTF(upperHash("base1230").slice(0, 14)).writeUTF("base").writeInt(0).toBuffer(), state);
    expect(c.minClientVersion).toBe(123);
    expect(c.minServerVersion).toBe(456);
    expect(solvePowChallenge(c)).toBe("0");
  });

  it("keeps leading zeroes in vanilla SHA-256 targets", () => {
    const c = parsePowChallenge(new ByteWriter().writeInt(1).writeInt(5)
      .writeBoolean(false).writeBoolean(false).writeUTF("0B1ACB9CD5FB07")
      .writeUTF("audit-").writeInt(3).toBuffer());
    expect(solvePowChallenge(c)).toBe("3");
  });

  it.each([3, 4])("uses padded uppercase SHA-256 for type %i", (type) => {
    expect(solvePowChallenge({ id: 1, type, minClientVersion: 55, minServerVersion: 66 }))
      .toBe(upperHash("55|66").slice(0, 14));
  });

  it("does not change saved parameters when a challenge is truncated", () => {
    const state = { minClientVersion: 55, minServerVersion: 66 };
    const parse = parsePowChallenge as (payload: Buffer, state: { minClientVersion: number; minServerVersion: number }) => ReturnType<typeof parsePowChallenge>;
    expect(() => parse(new ByteWriter().writeInt(1).writeInt(5).writeBoolean(true)
      .writeInt(123).writeBoolean(false).toBuffer(), state)).toThrow();
    expect(state).toEqual({ minClientVersion: 55, minServerVersion: 66 });
  });

  it("handles bounded work, no matching solution, and string repetition", () => {
    expect(solvePowChallenge({ id: 1, type: 5, minClientVersion: null, minServerVersion: null, maxIter: 10000001 })).toBe("max");
    expect(solvePowChallenge({ id: 1, type: 5, minClientVersion: null, minServerVersion: null, targetHash: "impossible", maxIter: 0 })).toBe("-1");
    const c = parsePowChallenge(new ByteWriter().writeInt(1).writeInt(7).writeBoolean(false).writeBoolean(false)
      .writeUTF("ab").writeInt(3).toBuffer()); expect(solvePowChallenge(c)).toBe("ababab");
    expect(solvePowChallenge({ ...c, repeatCount: 10001 })).toBe("max");
    expect(solvePowChallenge({ ...c, repeatCount: -1 })).toBe("");
  });
});
