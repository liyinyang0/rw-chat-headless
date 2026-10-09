import { describe, expect, it, vi } from "vitest";
import { isRoomUnavailablePrompt, parseRelayRedirect, Session } from "../src/client/session.ts";
import { ByteWriter } from "../src/protocol/primitives.ts";

describe("parseRelayRedirect (178 跳转地址解析)", () => {
  it.each(["[TCP]z.relay.cnkd.fun/kz198:5123", "[TCP]1.2.3.4:5124", "[TCP]example.com/abc123", "example.com"])
    ("preserves the complete connection string %s", (address) => {
      const payload = new ByteWriter().writeByte(0).writeInt(0).writeBoolean(false).writeInt(1).writeUTF(address).toBuffer();
      expect(parseRelayRedirect(payload).addresses).toEqual([address]);
    });
  it("does not scan raw text as a binary packet", () => {
    expect(() => parseRelayRedirect(Buffer.from("goto 5.6.7.8:9000 now"))).toThrow();
  });
});

describe("relay room selection failures", () => {
  it("recognizes the relay prompt used for missing or closed rooms", () => {
    expect(isRoomUnavailablePrompt("房间ID: r23423 不存在或已关闭，请重新输入房间ID")).toBe(true);
    expect(isRoomUnavailablePrompt("[ r23423 ] 我们找不到这个服务器")).toBe(true);
    expect(isRoomUnavailablePrompt("GAME NOT FOUND")).toBe(true);
    expect(isRoomUnavailablePrompt("请输入房间ID")).toBe(false);
  });
});

describe("Session 120/122 phase lifecycle", () => {
  it("120 enters in_game; 122 returns to lobby and emits gameEnded once", () => {
    const session = new Session(
      { host: "127.0.0.1", port: 5123, label: "fixture" },
      { playerName: "headless", onGameStart: "stay" },
    );
    const phases: string[] = [];
    let ended = 0;
    const send = vi.fn();
    (session as any).conn = { send };
    session.on("phaseChange", (phase) => phases.push(phase));
    session.on("gameEnded", () => { ended++; });

    (session as any).onGameStart();
    expect(session.phase).toBe("in_game");
    (session as any).onReturnToLobby();
    expect(session.phase).toBe("lobby");
    (session as any).onReturnToLobby();

    expect(phases).toEqual(["in_game", "lobby", "lobby"]);
    expect(ended).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
