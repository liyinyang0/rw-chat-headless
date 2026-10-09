import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RwConnection } from "../src/client/connection.ts";
import { Session } from "../src/client/session.ts";
import { ByteWriter } from "../src/protocol/primitives.ts";
import { basicTeam, teamPacket } from "./fixtures/room-wire.ts";

const sessions: Session[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(RwConnection.prototype, "connect").mockResolvedValue();
  vi.spyOn(RwConnection.prototype, "send").mockImplementation(() => {});
});
afterEach(() => { for (const s of sessions.splice(0)) s.disconnect(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(options: Record<string, unknown> = {}) {
  const s = new Session({ host: "127.0.0.1", port: 1, label: "timer fixture" }, {
    playerName: "timer", clientUuid: "timer", joinTimeoutMs: 100, receiveTimeoutMs: 100, ...options,
  });
  sessions.push(s); await s.start();
  const connection = (s as any).conn as RwConnection;
  const frame = (type: number, payload: Buffer) => connection.emit("frame", { type, payload });
  return { s, frame, connection };
}
const heartbeat = () => new ByteWriter().writeLong(1n).writeByte(0).toBuffer();

describe("session join and receive deadlines", () => {
  it("ends an unanswered handshake once", async () => {
    const { s } = await fixture(); const ended = vi.fn(); s.on("disconnected", ended);
    await vi.advanceTimersByTimeAsync(100); expect(s.state).toBe("disconnected");
    expect(ended).toHaveBeenCalledWith("join timeout");
    await vi.advanceTimersByTimeAsync(1000); expect(ended).toHaveBeenCalledTimes(1);
  });
  it("does not extend the join deadline for heartbeats or announcements", async () => {
    const { s, frame } = await fixture(); await vi.advanceTimersByTimeAsync(80); frame(108, heartbeat());
    await vi.advanceTimersByTimeAsync(20); expect(s.state).toBe("disconnected");
  });
  it("does not reset the total join budget at relay redirects", async () => {
    const { s, frame } = await fixture(); await vi.advanceTimersByTimeAsync(80);
    frame(178, new ByteWriter().writeByte(0).writeInt(0).writeBoolean(false).writeInt(1).writeUTF("127.0.0.1:2").toBuffer());
    await vi.advanceTimersByTimeAsync(20); expect(s.state).toBe("disconnected");
  });
  it("starts a new deadline after a successful session is explicitly restarted", async () => {
    const { s, frame } = await fixture(); frame(115, teamPacket(false, [basicTeam(0, "host")]));
    await s.start(); await vi.advanceTimersByTimeAsync(100); expect(s.state).toBe("disconnected");
  });
  it("bounds registration when an already-joined server redirects to a silent node", async () => {
    const { s, frame } = await fixture(); frame(115, teamPacket(false, [basicTeam(0, "host")]));
    frame(178, new ByteWriter().writeByte(0).writeInt(0).writeBoolean(false).writeInt(1).writeUTF("127.0.0.1:2").toBuffer());
    await vi.advanceTimersByTimeAsync(100); expect(s.state).toBe("disconnected");
  });
  it("keeps a quiet chat connection alive on incoming 108 without requiring 109", async () => {
    const { s, frame } = await fixture(); frame(115, teamPacket(false, [basicTeam(0, "host")]));
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(80); frame(108, heartbeat()); }
    expect(s.state).toBe("battleroom");
    await vi.advanceTimersByTimeAsync(100); expect(s.state).toBe("disconnected");
  });
  it("counts game frames as received activity, but ignores old connections", async () => {
    const { s, connection, frame } = await fixture(); frame(115, teamPacket(false, [basicTeam(0, "host")]));
    await vi.advanceTimersByTimeAsync(80); frame(10, Buffer.alloc(1));
    await vi.advanceTimersByTimeAsync(80); expect(s.state).toBe("battleroom");
    await s.start(); (s as any).conn.emit("frame", { type: 115, payload: teamPacket(false, [basicTeam(0, "host")]) });
    await vi.advanceTimersByTimeAsync(80); connection.emit("frame", { type: 108, payload: heartbeat() });
    await vi.advanceTimersByTimeAsync(20); expect(s.state).toBe("disconnected");
  });
  it("suspends join time while awaiting user input and resumes the remaining budget", async () => {
    const { s, frame } = await fixture({ inputTimeoutMs: 1000 }); await vi.advanceTimersByTimeAsync(80);
    frame(117, new ByteWriter().writeByte(0).writeInt(1).writeUTF("verification token").toBuffer());
    await vi.advanceTimersByTimeAsync(200); expect(s.state).not.toBe("disconnected");
    s.pendingInputRequest?.respond("answer"); await vi.advanceTimersByTimeAsync(20);
    expect(s.state).toBe("disconnected");
  });
  it("allows deadlines to be disabled and clears timers on manual close", async () => {
    const { s } = await fixture({ joinTimeoutMs: 0, receiveTimeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(10000); expect(s.state).toBe("awaiting-preregister");
    s.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });
});
