import { describe, expect, it } from "vitest";
import { mergeRosterDelta } from "../src/client/session.ts";
import type { TeamEntry } from "../src/protocol/packets/room.ts";

function entry(partial: Partial<TeamEntry> & Pick<TeamEntry, "slotId">): TeamEntry {
  return {
    allyTeamId: 0,
    name: "玩家",
    isSpectator: false,
    connectionActive: true,
    pingMs: 25,
    isAi: false,
    hostFlag: null,
    assignedColorIndex: null,
    ...partial,
    teamId: partial.slotId,
    slotId: partial.slotId,
  };
}

describe("mergeRosterDelta", () => {
  it("精简增量只更新在线状态，不清掉完整名单字段", () => {
    const current = [entry({ slotId: 2, name: "房主", allyTeamId: 1, isSpectator: true, hostFlag: 7 })];
    const delta = [entry({
      slotId: 2,
      name: null,
      allyTeamId: null,
      connectionActive: false,
      pingMs: -1,
      hostFlag: null,
    })];
    expect(mergeRosterDelta(current, delta)).toEqual([
      expect.objectContaining({
        slotId: 2,
        name: "房主",
        allyTeamId: 1,
        isSpectator: true,
        hostFlag: 7,
        connectionActive: false,
      }),
    ]);
  });
});
