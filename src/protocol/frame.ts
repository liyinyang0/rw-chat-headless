import { ByteReader, ByteWriter } from "./primitives.ts";

export interface Frame {
  type: number;
  payload: Buffer;
}

/** RW TCP 帧：[i32 大端 payload 长度][i32 大端 包类型][payload]。 */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeInt32BE(payload.length, 0);
  head.writeInt32BE(type, 4);
  return Buffer.concat([head, payload]);
}

/** 流式帧拆分器：feed 任意分块的 TCP 数据，产出完整帧。 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** 单帧载荷上限（对齐服务器对未注册连接的 10,000 字节限制，注册后为 1MB/50MB）。 */
  maxPayload = 50_000_000;

  feed(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 8) break;
      const len = this.buf.readInt32BE(0);
      if (len < 0) throw new Error(`frame decoder: negative payload length ${len}`);
      if (len > this.maxPayload) throw new Error(`frame decoder: payload too large ${len}`);
      if (this.buf.length < 8 + len) break;
      const type = this.buf.readInt32BE(4);
      const payload = Buffer.from(this.buf.subarray(8, 8 + len));
      this.buf = this.buf.subarray(8 + len);
      frames.push({ type, payload });
    }
    return frames;
  }
}

/** 便于在帧 payload 上读字段的语法糖。 */
export function readerOf(frame: Frame): ByteReader {
  return new ByteReader(frame.payload);
}

export function writerOf(): ByteWriter {
  return new ByteWriter();
}
