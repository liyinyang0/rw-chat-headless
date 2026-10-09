import { gunzipSync } from "node:zlib";
import { ByteReader, ByteWriter } from "./primitives.ts";

/**
 * StreamBlock：RW 大块数据（"teams"、"customUnits" 等）的框定格式。
 *
 * 父流视角（GameOutputStream.endBlock / GameInputStream.startBlockAndGetName）：
 *   [UTF 块名][i32 数据长度][块数据]
 * 块数据是否 gzip 不在字节流里标记，由调用方按上下文（streamVersion 等）约定。
 */

export interface RawBlock {
  name: string;
  /** 未解压的原始块数据（需要时由调用方 gunzip）。 */
  data: Buffer;
}

/** 读取一个块头+数据（并从父 reader 消费对应字节）。 */
export function readBlock(parent: ByteReader): RawBlock {
  const name = parent.readUTF();
  const len = parent.readInt();
  const data = parent.readBytes(len);
  return { name, data };
}

/** 跳过一个块（不关心内容时；对齐 GameInputStream.c(name)）。 */
export function skipBlock(parent: ByteReader): string {
  const name = parent.readUTF();
  const len = parent.readInt();
  parent.skip(len);
  return name;
}

/** 按需解压块数据。 */
export function inflateBlock(block: RawBlock): Buffer {
  return gunzipSync(block.data);
}

/** 把数据作为一个块写入父 writer。 */
export function writeBlock(w: ByteWriter, name: string, data: Buffer): void {
  w.writeUTF(name);
  w.writeInt(data.length);
  w.writeBytes(data);
}
