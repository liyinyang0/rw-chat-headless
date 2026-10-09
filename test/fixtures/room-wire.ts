import { gzipSync } from "node:zlib";
import { ByteWriter } from "../../src/protocol/primitives.ts";
import { writeBlock } from "../../src/protocol/block.ts";

// Independent vanilla write-side fixture: 02b game/n.b(as), n.c(as), j/ad.e(c).
export function basicTeam(slot: number, name: string, ally = 0, ping = 42, ai = false): Buffer {
  return new ByteWriter().writeBoolean(true).writeInt(ai ? 1 : 0).writeByte(slot).writeInt(4000)
    .writeInt(ally).writeStringNullable(name).writeBoolean(false).writeInt(ping).writeLong(1234n)
    .writeBoolean(ai).writeInt(3).writeInt(slot).writeByte(0).writeBoolean(false).writeBoolean(false)
    .writeBoolean(false).writeBoolean(false).writeInt(0).writeStringNullable(null).writeInt(slot === 0 ? 1 : 0)
    .writeIntNullable(null).writeIntNullable(null).writeIntNullable(null).writeIntNullable(null).writeInt(slot).toBuffer();
}

export function compactTeam(ping = 55, manual = false, automatic = false): Buffer {
  return new ByteWriter().writeBoolean(true).writeInt(0).writeByte(0).writeInt(ping)
    .writeBoolean(manual).writeBoolean(automatic).toBuffer();
}

export const absentTeam = () => new ByteWriter().writeBoolean(false).toBuffer();

export function teamPacket(compact: boolean, entries: Buffer[], paused = false, settingsVersion = 5): Buffer {
  const w = new ByteWriter().writeInt(1).writeBoolean(compact).writeInt(entries.length);
  writeBlock(w, "teams", gzipSync(Buffer.concat(entries)));
  w.writeInt(2).writeInt(4000).writeBoolean(true).writeInt(2).writeByte(settingsVersion)
    .writeInt(750).writeInt(1000);
  if (settingsVersion >= 2) w.writeInt(1).writeFloat(1).writeBoolean(false).writeBoolean(false);
  if (settingsVersion >= 3) w.writeBoolean(false);
  if (settingsVersion >= 4) w.writeBoolean(true);
  if (settingsVersion >= 5) w.writeBoolean(paused);
  return w.toBuffer();
}

export function startPacket(type = 0, map = "maps/skirmish/new.tmx"): Buffer {
  const w = new ByteWriter().writeByte(0).writeInt(type);
  if (type === 1 || type === 2) w.writeInt(3).writeBytes(Buffer.from([1, 2, 3]));
  return w.writeUTF(map).writeBoolean(true).toBuffer();
}
