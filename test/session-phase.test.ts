import { describe, expect, it, vi } from "vitest";
import { isRoomUnavailablePrompt, parseRelayRedirect, Session } from "../src/client/session.ts";

describe("parseRelayRedirect (178 跳转地址解析)", () => {
  it("parses host/room:port — CNKD 系中继把第二跳房间码内嵌在路径里", () => {
    expect(parseRelayRedirect("[TCP]z.relay.cnkd.fun/kz198:5123")).toEqual({
      host: "z.relay.cnkd.fun",
      port: 5123,
      room: "kz198",
    });
  });

  it("parses plain host:port", () => {
    expect(parseRelayRedirect("[TCP]1.2.3.4:5124")).toEqual({ host: "1.2.3.4", port: 5124, room: null });
  });

  it("defaults port to 5123 when the path carries no port", () => {
    expect(parseRelayRedirect("[TCP]example.com/abc123")).toEqual({
      host: "example.com",
      port: 5123,
      room: "abc123",
    });
  });

  it("falls back to bare host:port match without the [TCP] prefix", () => {
    expect(parseRelayRedirect("goto 5.6.7.8:9000 now")).toEqual({ host: "5.6.7.8", port: 9000, room: null });
  });

  it("returns null when no address is present", () => {
    expect(parseRelayRedirect("no address here")).toBeNull();
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
