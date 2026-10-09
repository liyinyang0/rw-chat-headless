/**
 * Java DataInput/DataOutput 语义的基础类型编解码。
 *
 * RW 协议的所有多字节整数/浮点均为大端；字符串为 Java "modified UTF-8"
 * （2 字节字节长度前缀 + 变长编码，详见 encodeModifiedUtf8）。
 * 规格来源：RWX 源码 GameInputStream/GameOutputStream（DataInputStream 薄封装）。
 */

/** Java modified UTF-8 编码。返回不带长度前缀的字节。 */
export function encodeModifiedUtf8(str: string): Buffer {
  const out: number[] = [];
  const push3 = (cp: number) => {
    out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  };
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x01 && cp <= 0x7f) {
      out.push(cp);
    } else if (cp === 0x00 || (cp >= 0x80 && cp <= 0x7ff)) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0x800 && cp <= 0xffff) {
      push3(cp);
    } else {
      // 增补平面：Java 会先拆成代理对，再各按 3 字节编码 → 共 6 字节
      const v = cp - 0x10000;
      push3(0xd800 + (v >> 10));
      push3(0xdc00 + (v & 0x3ff));
    }
  }
  return Buffer.from(out);
}

/** 解码 Java modified UTF-8 字节（不带长度前缀）为 JS 字符串。 */
export function decodeModifiedUtf8(buf: Buffer): string {
  const units: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i]!;
    if (b & 0x80) {
      if ((b & 0xe0) === 0xc0) {
        const b2 = buf[i + 1]!;
        units.push(((b & 0x1f) << 6) | (b2 & 0x3f));
        i += 2;
      } else if ((b & 0xf0) === 0xe0) {
        const b2 = buf[i + 1]!;
        const b3 = buf[i + 2]!;
        units.push(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
        i += 3;
      } else {
        // modified UTF-8 不存在 4 字节序列；容错按 Latin-1 处理避免崩溃
        units.push(b);
        i += 1;
      }
    } else {
      units.push(b);
      i += 1;
    }
  }
  // String.fromCharCode 可接受代理对序列（与 Java 读回语义一致，孤立代理原样保留）
  let out = "";
  for (let j = 0; j < units.length; j += 4096) {
    out += String.fromCharCode(...units.slice(j, j + 4096));
  }
  return out;
}

export class ProtocolError extends Error {}

export class ByteWriter {
  private chunks: Buffer[] = [];
  private len = 0;

  private push(buf: Buffer) {
    this.chunks.push(buf);
    this.len += buf.length;
  }

  get length(): number {
    return this.len;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.len);
  }

  writeByte(v: number): this {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.push(b);
    return this;
  }

  writeBoolean(v: boolean): this {
    return this.writeByte(v ? 1 : 0);
  }

  writeShort(v: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.push(b);
    return this;
  }

  writeInt(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v | 0);
    this.push(b);
    return this;
  }

  writeLong(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v)));
    this.push(b);
    return this;
  }

  writeFloat(v: number): this {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    this.push(b);
    return this;
  }

  writeDouble(v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    this.push(b);
    return this;
  }

  writeBytes(buf: Buffer): this {
    this.push(buf);
    return this;
  }

  /** Java DataOutputStream.writeUTF：u16 字节长度前缀 + modified UTF-8。 */
  writeUTF(str: string): this {
    const data = encodeModifiedUtf8(str);
    if (data.length > 0xffff) {
      throw new ProtocolError(`writeUTF: encoded length ${data.length} exceeds 65535`);
    }
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(data.length);
    this.push(prefix);
    this.push(data);
    return this;
  }

  /** nullable 字符串：1 字节存在标志 + UTF。null 与空串可区分。 */
  writeStringNullable(str: string | null): this {
    if (str === null) {
      return this.writeBoolean(false);
    }
    this.writeBoolean(true);
    return this.writeUTF(str);
  }

  /** nullable int：1 字节存在标志 + i32。 */
  writeIntNullable(v: number | null): this {
    if (v === null) {
      return this.writeBoolean(false);
    }
    this.writeBoolean(true);
    return this.writeInt(v);
  }
}

export class ByteReader {
  private pos = 0;
  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private take(n: number): Buffer {
    if (this.pos + n > this.buf.length) {
      throw new ProtocolError(
        `read underflow: need ${n} bytes at offset ${this.pos}, have ${this.buf.length - this.pos}`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readByte(): number {
    return this.take(1).readInt8();
  }

  readUnsignedByte(): number {
    return this.take(1).readUInt8();
  }

  readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  readShort(): number {
    return this.take(2).readInt16BE();
  }

  readInt(): number {
    return this.take(4).readInt32BE();
  }

  readLong(): bigint {
    return this.take(8).readBigInt64BE();
  }

  readFloat(): number {
    return this.take(4).readFloatBE();
  }

  readDouble(): number {
    return this.take(8).readDoubleBE();
  }

  readBytes(n: number): Buffer {
    return Buffer.from(this.take(n));
  }

  readUTF(): string {
    const len = this.take(2).readUInt16BE();
    return decodeModifiedUtf8(this.take(len));
  }

  readNullableString(): string | null {
    if (!this.readBoolean()) return null;
    return this.readUTF();
  }

  readNullableInt(): number | null {
    if (!this.readBoolean()) return null;
    return this.readInt();
  }

  skip(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new ProtocolError(`skip underflow: ${n} bytes at offset ${this.pos}`);
    }
    this.pos += n;
  }

  /** 剩余字节作为新 reader（不清耗本 reader）。 */
  restView(): ByteReader {
    return new ByteReader(this.buf.subarray(this.pos));
  }
}
