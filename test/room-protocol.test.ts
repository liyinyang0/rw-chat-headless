import { describe, expect, it } from "vitest";
import { ByteWriter } from "../src/protocol/primitives.ts";
import { parseServerInfo } from "../src/protocol/packets/room.ts";

describe("SERVER_INFO 106", () => {
  it("保留客户端可见的经济、禁核和队伍设置", () => {
    const payload = new ByteWriter()
      .writeUTF("com.corrodinggames.rts")
      .writeInt(176)
      .writeInt(0)
      .writeUTF("maps/skirmish/Crossing.tmx")
      .writeInt(4000)
      .writeInt(2)
      .writeBoolean(true)
      .writeInt(3)
      .writeByte(8)
      .writeBoolean(false)
      .writeBoolean(false)
      .writeInt(750)
      .writeInt(1000)
      .writeInt(2)
      .writeFloat(1.5)
      .writeBoolean(true)
      .writeBoolean(false)
      .writeBoolean(false)
      .writeBoolean(true)
      .writeBoolean(true)
      .writeBoolean(false)
      .writeBoolean(true)
      .writeBoolean(false)
      .writeInt(12345)
      .toBuffer();

    expect(parseServerInfo(payload)).toMatchObject({
      mapPath: "maps/skirmish/Crossing.tmx",
      startingCredits: 4000,
      startingUnits: 2,
      incomeMultiplier: 1.5,
      noNukes: true,
      sharedControl: true,
      teamLock: true,
      fixedAllyTeams: false,
      allowSpectators: true,
      roomLock: false,
    });
  });
});
