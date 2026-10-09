import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { runMultiRooms, type MultiRoomOptions, type SessionLike } from "../src/client/multi.ts";
import type { ConnectTarget } from "../src/masterserver/target.ts";
import type { SessionEvents, SessionOptions, SessionState } from "../src/client/session.ts";
import type { PreregisterInfo } from "../src/protocol/packets/common.ts";
import type { TeamEntry } from "../src/protocol/packets/room.ts";

/** fake 会话：start 后直接进 battleroom；可注入踢出/失败。 */
class FakeSession extends EventEmitter {
  state: SessionState = "idle";
  info: PreregisterInfo | null = null;
  roster: TeamEntry[] = [];
  roomInfo = null;
  sent: string[] = [];
  disconnected: string | null = null;

  constructor(
    readonly opts: SessionOptions,
    private readonly uuid: string,
    private readonly behavior: "ok" | "fail" = "ok",
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.behavior === "fail") throw new Error("boom: dial refused");
    this.state = "battleroom";
    this.info = { serverUuid: this.uuid } as PreregisterInfo;
    this.emit("stateChange", "battleroom" satisfies SessionState);
  }

  sendChat(message: string): void {
    this.sent.push(message);
  }

  disconnect(reason = "leaving"): void {
    if (this.disconnected) return;
    this.disconnected = reason;
    this.state = "disconnected";
    this.emit("stateChange", "disconnected" satisfies SessionState);
  }
}

interface Fixture {
  sessions: FakeSession[];
  created: { target: ConnectTarget; opts: SessionOptions }[];
}

function makeFactory(uuids: string[], failIndex = -1): (target: ConnectTarget, opts: SessionOptions) => SessionLike {
  const fixture: Fixture = { sessions: [], created: [] };
  const factory = (target: ConnectTarget, opts: SessionOptions): SessionLike => {
    const i = fixture.created.length;
    const s = new FakeSession(opts, uuids[i] ?? `uuid-${i}`, i === failIndex ? "fail" : "ok");
    if (i !== failIndex) {
      s.roster = [
        { name: "房主", teamId: 0, isAi: false, connectionActive: true, isSpectator: false },
        { name: opts.playerName, teamId: 1, isAi: false, connectionActive: true, isSpectator: false },
      ] as TeamEntry[];
    }
    fixture.sessions.push(s);
    fixture.created.push({ target, opts });
    return s as unknown as SessionLike;
  };
  (factory as unknown as { fixture: Fixture }).fixture = fixture;
  return factory;
}

function fixtureOf(factory: ReturnType<typeof makeFactory>): Fixture {
  return (factory as unknown as { fixture: Fixture }).fixture;
}

function baseOpts(factory: ReturnType<typeof makeFactory>, over: Partial<MultiRoomOptions> = {}): MultiRoomOptions {
  return {
    targets: ["10.1.1.1:9001", "10.1.1.2:9002", "10.1.1.3:9003"],
    playerName: "headless",
    staggerMs: 1,
    settleTimeoutMs: 2000,
    createSession: factory,
    log: () => {},
    ...over,
  };
}

describe("runMultiRooms", () => {
  it("closes a session still waiting for registration when settle times out", async () => {
    const factory = (target: ConnectTarget, opts: SessionOptions) => {
      const s = new FakeSession(opts, "pending");
      s.start = async () => { s.state = "awaiting-register"; };
      return s;
    };
    const run = await runMultiRooms({ targets: ["127.0.0.1:1"], playerName: "timer", createSession: factory, settleTimeoutMs: 10, log: () => {} });
    expect(run.handles[0]!.state()).toBe("disconnected");
    expect(run.handles[0]!.snapshot().error).toBe("join timeout");
    await run.close();
  });
  it("can opt into managed reconnect without replaying stale sessions", async () => {
    const factory = makeFactory(["first", "second"]);
    const run = await runMultiRooms(baseOpts(factory, { targets: ["127.0.0.1:1"], reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 } } as Partial<MultiRoomOptions>));
    const fixtures = fixtureOf(factory); const first = fixtures.sessions[0]!;
    first.disconnect(); first.emit("disconnected", "socket closed");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(fixtures.sessions).toHaveLength(2); expect(run.handles[0]!.roomId()).toBe("second");
    await run.close();
  });
  it("三个目标同时进房，roomId 各自就位", async () => {
    const factory = makeFactory(["uuid-aaa", "uuid-bbb", "uuid-ccc"]);
    const run = await runMultiRooms(baseOpts(factory));
    expect(run.handles).toHaveLength(3);
    expect(run.handles.map((h) => h.state())).toEqual(["battleroom", "battleroom", "battleroom"]);
    expect(run.handles.map((h) => h.roomId())).toEqual(["uuid-aaa", "uuid-bbb", "uuid-ccc"]);
    await run.close();
  });

  it("每会话 clientId 唯一且带槽位后缀", async () => {
    const factory = makeFactory(["u1", "u2", "u3"]);
    const run = await runMultiRooms(baseOpts(factory, { clientIdBase: "fixed-seed-001" }));
    const created = fixtureOf(factory).created;
    const ids = created.map((c) => c.opts.clientUuid);
    expect(ids).toEqual(["fixed-seed-001-m1", "fixed-seed-001-m2", "fixed-seed-001-m3"]);
    expect(new Set(ids).size).toBe(3);
    await run.close();
  });

  it("所有中继跳转沿用调用方指定的 SOCKS 出口", async () => {
    const factory = makeFactory(["u1", "u2", "u3"]);
    const socksProxy = { host: "127.0.0.1", port: 41081 };
    const run = await runMultiRooms(baseOpts(factory, { socksProxy }));
    expect(fixtureOf(factory).created.map((entry) => entry.opts.socksProxy)).toEqual([
      socksProxy,
      socksProxy,
      socksProxy,
    ]);
    await run.close();
  });

  it("玩家名 suffix 策略：第二个起加 -2/-3；same 策略全部同名", async () => {
    const factoryA = makeFactory(["u1", "u2", "u3"]);
    const runA = await runMultiRooms(baseOpts(factoryA));
    expect(fixtureOf(factoryA).created.map((c) => c.opts.playerName)).toEqual(["headless", "headless-2", "headless-3"]);
    await runA.close();

    const factoryB = makeFactory(["u1", "u2", "u3"]);
    const runB = await runMultiRooms(baseOpts(factoryB, { nameStrategy: "same" }));
    expect(fixtureOf(factoryB).created.map((c) => c.opts.playerName)).toEqual(["headless", "headless", "headless"]);
    await runB.close();
  });

  it("聊天进入对应房间的 history", async () => {
    const factory = makeFactory(["u1", "u2"]);
    const run = await runMultiRooms(baseOpts(factory, { targets: ["10.1.1.1:9001", "10.1.1.2:9002"] }));
    fixtureOf(factory).sessions[1]!.emit("chat", { senderName: "房主", message: "hello" });
    expect(run.handles[0]!.history()).toEqual([]);
    expect(run.handles[1]!.history()).toEqual([{ time: expect.any(String), name: "房主", message: "hello" }]);
    await run.close();
  });

  it("重复目标直接拒绝", async () => {
    const factory = makeFactory(["u1", "u2"]);
    await expect(runMultiRooms(baseOpts(factory, { targets: ["10.1.1.1:9001", "10.1.1.1:9001"] }))).rejects.toThrow(
      /重复目标/,
    );
  });

  it("单房启动失败不影响其余房间", async () => {
    const factory = makeFactory(["u1", "u2", "u3"], 1);
    const run = await runMultiRooms(baseOpts(factory));
    expect(run.handles[0]!.state()).toBe("battleroom");
    expect(run.handles[1]!.state()).toBe("idle");
    expect(run.handles[1]!.snapshot().error).toMatch(/boom/);
    expect(run.handles[2]!.state()).toBe("battleroom");
    await run.close();
  });

  it("close 断开全部会话", async () => {
    const factory = makeFactory(["u1", "u2"]);
    const run = await runMultiRooms(baseOpts(factory, { targets: ["10.1.1.1:9001", "10.1.1.2:9002"] }));
    await run.close();
    for (const s of fixtureOf(factory).sessions) expect(s.disconnected).not.toBeNull();
  });
});
