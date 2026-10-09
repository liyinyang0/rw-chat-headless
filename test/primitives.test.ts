import { describe, expect, it } from "vitest";
import {
  ByteReader,
  ByteWriter,
  decodeModifiedUtf8,
  encodeModifiedUtf8,
} from "../src/protocol/primitives.ts";

describe("modified UTF-8", () => {
  it("ASCII 与 Java writeUTF 黄金字节一致", () => {
    // Java: DataOutputStream.writeUTF("abc") → 00 03 61 62 63
    const w = new ByteWriter().writeUTF("abc");
    expect(w.toBuffer().equals(Buffer.from([0x00, 0x03, 0x61, 0x62, 0x63]))).toBe(true);
  });

  it("空串 = 00 00（长度前缀 0）", () => {
    const w = new ByteWriter().writeUTF("");
    expect(w.toBuffer().equals(Buffer.from([0x00, 0x00]))).toBe(true);
  });

  it("U+0000 编码为 2 字节 C0 80（modified UTF-8 特有）", () => {
    const enc = encodeModifiedUtf8("\u0000");
    expect(enc.equals(Buffer.from([0xc0, 0x80]))).toBe(true);
  });

  it("中文按 3 字节编码", () => {
    const enc = encodeModifiedUtf8("周");
    // U+5468 → E5 91 A8
    expect(enc.equals(Buffer.from([0xe5, 0x91, 0xa8]))).toBe(true);
    const w = new ByteWriter().writeUTF("周");
    expect(w.toBuffer().equals(Buffer.from([0x00, 0x03, 0xe5, 0x91, 0xa8]))).toBe(true);
  });

  it("U+0080–U+07FF 按 2 字节编码", () => {
    const enc = encodeModifiedUtf8("©"); // U+00A9
    expect(enc.equals(Buffer.from([0xc2, 0xa9]))).toBe(true);
  });

  it("增补平面字符编码为 6 字节（代理对各 3 字节）", () => {
    const enc = encodeModifiedUtf8("𝐀"); // U+1D400 → 代理对 D835 DC00
    expect(enc.length).toBe(6);
    expect(enc.equals(Buffer.from([0xed, 0xa0, 0xb5, 0xed, 0xb0, 0x80]))).toBe(true);
    expect(decodeModifiedUtf8(enc)).toBe("𝐀");
  });

  it("往返一致（混合文本）", () => {
    const s = "无头客户端 abc©\u0000𝐀 日本語";
    const round = decodeModifiedUtf8(encodeModifiedUtf8(s));
    expect(round).toBe(s);
  });

  it("中文长度前缀是字节数", () => {
    const w = new ByteWriter().writeUTF("无头");
    expect(w.toBuffer().readUInt16BE(0)).toBe(6);
  });
});

describe("nullable 与数值", () => {
  it("nullable string：null=00，空串=01 00 00", () => {
    expect(new ByteWriter().writeStringNullable(null).toBuffer().equals(Buffer.from([0x00]))).toBe(true);
    expect(
      new ByteWriter().writeStringNullable("").toBuffer().equals(Buffer.from([0x01, 0x00, 0x00])),
    ).toBe(true);
    expect(new ByteWriter().writeStringNullable("a").toBuffer().equals(Buffer.from([0x01, 0x00, 0x01, 0x61]))).toBe(true);
  });

  it("nullable int：null=00，值=01 + i32", () => {
    const buf = new ByteWriter().writeIntNullable(null).writeIntNullable(7).toBuffer();
    const r = new ByteReader(buf);
    expect(r.readNullableInt()).toBeNull();
    expect(r.readNullableInt()).toBe(7);
  });

  it("大端整数与 long", () => {
    const buf = new ByteWriter().writeInt(0x11223344).writeLong(0x1122334455667788n).writeFloat(1.5).toBuffer();
    expect([...buf.subarray(0, 4)]).toEqual([0x11, 0x22, 0x33, 0x44]);
    const r = new ByteReader(buf);
    expect(r.readInt()).toBe(0x11223344);
    expect(r.readLong()).toBe(0x1122334455667788n);
    expect(r.readFloat()).toBeCloseTo(1.5);
  });

  it("writeInt 负数回绕", () => {
    const r = new ByteReader(new ByteWriter().writeInt(-15136268481).toBuffer());
    // Java int 溢出语义：-15136268481 mod 2^32
    expect(r.readInt()).toBe(-15136268481 | 0);
  });
});
