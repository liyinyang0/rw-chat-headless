import { afterEach, describe, expect, it, vi } from "vitest";
import { Session, mergeRosterDelta } from "../src/client/session.ts";
import { parseTeamList } from "../src/protocol/packets/room.ts";
import { ByteWriter } from "../src/protocol/primitives.ts";
import { absentTeam, basicTeam, compactTeam, startPacket, teamPacket } from "./fixtures/room-wire.ts";

const sessions: Session[] = [];
afterEach(() => { for (const s of sessions.splice(0)) s.disconnect(); });
function fixture() {
  const s = new Session({ host: "127.0.0.1", port: 1, label: "wire fixture" }, { playerName: "observer" });
  const send = vi.fn();
  Object.assign(s, { conn: { send, close: vi.fn() }, info: { networkVersion: 176 } });
  sessions.push(s);
  const frame = (type: number, payload: Buffer) => (s as any).handleFrame({ type, payload });
  return { s, send, frame };
}

describe("vanilla roster semantics", () => {
  it("distinguishes spectator, AI, ping and host from shared control", () => {
    const result = parseTeamList(teamPacket(false, [basicTeam(0, "host", 0, -99), basicTeam(1, "observer", -3), basicTeam(2, "AI", 1, -2, true)]), 176);
    expect(result.teams[0]).toMatchObject({ pingMs: -99, connectionActive: true, isHost: true });
    expect(result.teams[1]).toMatchObject({ isSpectator: true, isAi: false, pingMs: 42, connectionActive: true, sharedControlManual: false });
    expect(result.teams[2]).toMatchObject({ isSpectator: false, isAi: true, aiDifficulty: 3, pingMs: -2 });
  });
  it("uses the loop slot for compact records and removes absent players", () => {
    const old = parseTeamList(teamPacket(false, [basicTeam(0, "host"), basicTeam(1, "observer", -3), basicTeam(2, "other")]), 176);
    const update = parseTeamList(teamPacket(true, [absentTeam(), compactTeam(55, true), absentTeam()]), 176);
    const merged = mergeRosterDelta(old.teams, update.teams);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ slotId: 1, name: "observer", isSpectator: true, pingMs: 55, sharedControlManual: true });
    expect(mergeRosterDelta(merged, [])).toEqual([]);
  });
  it("does not use automatic control to mark a stale player as online", () => {
    expect(parseTeamList(teamPacket(true, [compactTeam(-1, false, true)]), 176).teams[0])
      .toMatchObject({ connectionActive: false, sharedControlAutomatic: true });
  });
  it("publishes paused/shared-control settings and preserves absent old-version fields", () => {
    const { s, frame } = fixture(); const change = vi.fn(); s.on("settingsChange" as any, change);
    frame(115, teamPacket(false, [basicTeam(0, "host")], true));
    expect(s.settings).toMatchObject({ gamePaused: true, sharedControl: true });
    frame(115, teamPacket(true, [compactTeam()], false, 3));
    expect(s.settings).toMatchObject({ gamePaused: true, sharedControl: true });
    frame(115, teamPacket(true, [compactTeam()], false));
    expect(s.settings).toMatchObject({ gamePaused: false }); expect(change).toHaveBeenCalled();
  });
  it("infers an already-running game from vanilla compact updates", () => {
    const { s, frame } = fixture(); frame(115, teamPacket(true, [compactTeam()]));
    expect(s.phase).toBe("in_game");
  });
});

describe("game lifecycle wire packets", () => {
  it.each([0, 1, 2])("reads type %i start metadata without retaining map/save bytes", (type) => {
    const { s, frame } = fixture(); const started = vi.fn(); s.on("gameStart" as any, started);
    frame(120, startPacket(type));
    expect(s.phase).toBe("in_game");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ mapPath: "maps/skirmish/new.tmx", mapDataBytes: type === 0 ? 0 : 3, lateJoin: true }));
  });
  it("ends once on 116 true, stays in game until 122, and resets for a new match", () => {
    const { s, frame } = fixture(); const ended = vi.fn(); s.on("gameEnded", ended);
    frame(120, startPacket());
    frame(116, new ByteWriter().writeInt(0).writeBoolean(false).toBuffer()); expect(ended).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) frame(116, new ByteWriter().writeInt(0).writeBoolean(true).toBuffer());
    expect(s.phase).toBe("in_game"); expect(ended).toHaveBeenCalledTimes(1);
    frame(122, Buffer.alloc(0)); expect(s.phase).toBe("lobby"); expect(ended).toHaveBeenCalledTimes(1);
    frame(120, startPacket()); frame(122, Buffer.alloc(0)); expect(ended).toHaveBeenCalledTimes(2);
  });
  it.each([116, 120])("rejects truncated lifecycle packet %i", (type) => {
    const { s, frame } = fixture(); frame(type, Buffer.alloc(0)); expect(s.state).toBe("disconnected");
  });
});
