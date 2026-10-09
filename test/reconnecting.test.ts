import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingSession, reconnectDelay } from "../src/client/reconnecting.ts";
import type { Session, SessionOptions, SessionState } from "../src/client/session.ts";
import type { ConnectTarget } from "../src/masterserver/target.ts";

class Fake extends EventEmitter {
  state: SessionState = "idle";
  info = null; roster = []; roomInfo = null; settings = {}; phase = "lobby";
  pingMs = null; slotCount = null; pendingInputRequest = null; gameStartInfo = null; serverEnded = false;
  sent: string[] = [];
  async start() { this.state = "battleroom"; this.emit("stateChange", this.state); }
  sendChat(text: string) { this.sent.push(text); return true; }
  disconnect(reason = "socket closed") { this.state = "disconnected"; this.emit("stateChange", this.state); this.emit("disconnected", reason); }
}
const managed: ReconnectingSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const s of managed.splice(0)) s.disconnect(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(options: Record<string, unknown> = {}, resolve?: (raw: string) => Promise<ConnectTarget>) {
  const sessions: Fake[] = []; const optionsSeen: SessionOptions[] = [];
  const resolver = vi.fn(async (raw: string, _password?: string | null): Promise<ConnectTarget> =>
    resolve ? resolve(raw) : { host: "127.0.0.1", port: sessions.length + 1, label: "resolved" });
  const s = new ReconnectingSession("r12345", { playerName: "bot", clientUuid: "stable", socksProxy: { host: "127.0.0.1", port: 99 } },
    { enabled: true, baseDelayMs: 10, maxDelayMs: 100, maxRetries: 2, ...options }, {
      resolve: resolver, random: () => 0.5,
      createSession: (_target, opts) => { const fake = new Fake(); sessions.push(fake); optionsSeen.push(opts); return fake as unknown as Session; },
    });
  managed.push(s); return { s, sessions, resolver, optionsSeen };
}

describe("optional reconnect ownership", () => {
  it("exposes metadata from the current source and empty values before resolving", async () => {
    const { s, sessions } = fixture();
    expect([s.info, s.roomInfo, s.pingMs, s.slotCount, s.gameStartInfo, s.pendingInputRequest]).toEqual(Array(6).fill(null));
    expect([s.roster, s.settings, s.phase, s.yourTeamId, s.serverEnded, s.reconnectCount]).toEqual([[], {}, "lobby", -1, false, 0]);
    expect(s.sendChat("before join")).toBe(false);
    await s.start();
    expect(s.settings).toBe(sessions[0]!.settings); expect(s.roster).toBe(sessions[0]!.roster);
    expect(s.phase).toBe("lobby"); expect(s.info).toBe(null); expect(s.roomInfo).toBe(null);
    expect(s.pingMs).toBe(null); expect(s.slotCount).toBe(null); expect(s.yourTeamId).toBe(-1);
    expect(s.gameStartInfo).toBe(null); expect(s.pendingInputRequest).toBe(null); expect(s.serverEnded).toBe(false);
    s.disconnect(); expect(s.sendChat("after leave")).toBe(false);
  });
  it("schedules one retry when start rejects after emitting disconnected", async () => {
    vi.spyOn(Fake.prototype, "start").mockImplementationOnce(async function(this: Fake) {
      this.disconnect("dial refused"); throw new Error("dial refused");
    });
    const { s, sessions } = fixture(); await s.start(); await vi.advanceTimersByTimeAsync(10);
    expect(sessions).toHaveLength(2); expect(s.reconnectCount).toBe(1);
  });
  it("preserves start rejection when reconnect is disabled", async () => {
    vi.spyOn(Fake.prototype, "start").mockImplementationOnce(async function(this: Fake) {
      this.disconnect("dial refused"); throw new Error("dial refused");
    });
    const { s } = fixture({ enabled: false }); await expect(s.start()).rejects.toThrow("dial refused");
  });
  it("uses bounded exponential backoff with jitter", () => {
    expect([0, 1, 2, 3, 4, 5].map(i => reconnectDelay(i, 5000, 60000, () => 0.5))).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(reconnectDelay(0, 5000, 60000, () => 0)).toBe(4500);
    expect(reconnectDelay(10, 5000, 60000, () => 1)).toBeLessThanOrEqual(60000);
  });
  it("re-resolves the original target and keeps identity/proxy after disconnect", async () => {
    const { s, sessions, resolver, optionsSeen } = fixture(); await s.start(); sessions[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions).toHaveLength(2); expect(resolver.mock.calls.map(c => c[0])).toEqual(["r12345", "r12345"]);
    expect(optionsSeen.map(o => o.clientUuid)).toEqual(["stable", "stable"]);
    expect(optionsSeen[1]!.socksProxy).toEqual(optionsSeen[0]!.socksProxy);
    expect(s.sendChat("new connection")).toBe(true); expect(sessions[1]!.sent).toEqual(["new connection"]);
  });
  it("does not schedule two retries for repeated close events", async () => {
    const { s, sessions } = fixture(); const original = s.start(); await original;
    sessions[0]!.disconnect(); sessions[0]!.disconnect(); await vi.advanceTimersByTimeAsync(10);
    expect(sessions).toHaveLength(2);
  });
  it("stops retrying when disabled", async () => {
    const { s, sessions } = fixture({ enabled: false }); await s.start(); sessions[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(1000); expect(sessions).toHaveLength(1);
  });
  it.each(["room not found", "invalid game start packet", "input cancelled", "banned", "Wrong password"])
    ("treats %s as terminal", async (reason) => {
      const { s, sessions } = fixture(); await s.start(); sessions[0]!.disconnect(reason);
      await vi.advanceTimersByTimeAsync(1000); expect(sessions).toHaveLength(1);
    });
  it("stops on a kick or a server-ended game", async () => {
    const first = fixture(); await first.s.start(); first.sessions[0]!.emit("kicked", "bye"); first.sessions[0]!.disconnect();
    const second = fixture(); await second.s.start(); second.sessions[0]!.serverEnded = true; second.sessions[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(1000); expect(first.sessions).toHaveLength(1); expect(second.sessions).toHaveLength(1);
  });
  it("cancels pending retry on manual stop", async () => {
    const { s, sessions } = fixture(); await s.start(); sessions[0]!.disconnect(); s.disconnect("user stopped");
    await vi.advanceTimersByTimeAsync(1000); expect(sessions).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores a target resolution completed after cancellation", async () => {
    let complete!: (target: ConnectTarget) => void;
    const { s, sessions } = fixture({}, async () => await new Promise<ConnectTarget>(r => { complete = r; }));
    const starting = s.start(); s.disconnect(); complete({ host: "127.0.0.1", port: 1, label: "late" }); await starting;
    expect(sessions).toHaveLength(0);
  });
  it("bounds retries and ignores events from replaced sessions", async () => {
    const { s, sessions } = fixture(); await s.start();
    sessions[0]!.disconnect(); await vi.advanceTimersByTimeAsync(10);
    const chats = vi.fn(); s.on("chat", chats); sessions[0]!.emit("chat", { message: "old" }); expect(chats).not.toHaveBeenCalled();
    sessions[1]!.disconnect("receive timeout"); await vi.advanceTimersByTimeAsync(20);
    sessions[2]!.disconnect("join timeout"); await vi.advanceTimersByTimeAsync(1000);
    expect(sessions).toHaveLength(3); expect(s.state).toBe("disconnected");
  });
  it("retries target lookup failures within the same budget", async () => {
    let calls = 0; const { s, sessions } = fixture({}, async () => {
      if (calls++ === 0) throw new Error("HTTP timeout");
      return { host: "127.0.0.1", port: 1, label: "retry" };
    });
    await s.start(); await vi.advanceTimersByTimeAsync(10); expect(sessions).toHaveLength(1);
  });
});
