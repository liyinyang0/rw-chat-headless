import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extraCheckString,
  formatServerCode,
  integrityString,
  javaDoubleToString,
} from "../src/protocol/integrity.ts";
import { md5Hex, repeatHash, sha256Hex, sha256ShortHash } from "../src/protocol/hashes.ts";
import { buildRegister } from "../src/protocol/packets/common.ts";
import { ByteReader, ByteWriter } from "../src/protocol/primitives.ts";
import { encodeFrame, FrameDecoder } from "../src/protocol/frame.ts";
import { readBlock, skipBlock, writeBlock } from "../src/protocol/block.ts";
import { gunzipSync, gzipSync } from "node:zlib";

describe("g()/h() 公式（黄金值由真 Java 按原版 RW 公式生成）", () => {
  const golden = readFileSync(join(__dirname, "fixtures", "golden-g.txt"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [seed, value] = line.split("\t");
      return { seed: seed!, value: value!.trim() };
    });

  it("所有种子与 Java 输出逐字节一致", () => {
    for (const { seed, value } of golden) {
      if (seed.startsWith("h")) {
        // h() 黄金行：seed 形如 "h6789"
        expect(extraCheckString(Number(seed.slice(1))), `${seed}`).toBe(value);
      } else {
        expect(integrityString(Number(seed)), `seed=${seed}`).toBe(value);
      }
    }
  });

  it("7: 字段用原版乘法（与真实原版客户端抓包一致）", () => {
    // 真实原版客户端对 seed=12345 的 7: 字段实测值（2026-09 抓包）
    expect(integrityString(12345)).toContain("7:746163520");
  });

  it("覆盖 int 回绕与科学计数样本", () => {
    // 样本必须包含负数回绕与 E 计数，防止黄金文件意外退化
    expect(golden.some((g) => g.value.includes("-"))).toBe(true);
    expect(golden.some((g) => /E\d/.test(g.value))).toBe(true);
  });
});

describe("javaDoubleToString", () => {
  it("整数 double 补 .0", () => {
    expect(javaDoubleToString(44000.0)).toBe("44000.0");
    expect(javaDoubleToString(0.0)).toBe("0.0");
  });
  it("≥1e7 科学计数", () => {
    expect(javaDoubleToString(54296000.0)).toBe("5.4296E7");
    expect(javaDoubleToString(44000000000.0)).toBe("4.4E10");
  });
  it("<1e-3 科学计数（JS 默认不会切）", () => {
    expect(javaDoubleToString(0.0001)).toBe("1.0E-4");
  });
});

describe("hashes", () => {
  it("md5/sha256 已知向量", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(sha256ShortHash("abc")).toBe("ba7816bf8f01cf");
  });
  it("repeatHash 迭代次数", () => {
    expect(repeatHash("abc", 3)).not.toBe(repeatHash("abc", 2));
    expect(repeatHash("abc", 0)).toBe(
      "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );
  });
});

describe("客户端身份派生", () => {
  function registeredClientId(serverUuid: string): string {
    const payload = buildRegister({
      playerName: "headless",
      networkVersion: 176,
      formatVersion: 5,
      clientUuid: "room-stable-seed",
      serverUuid,
    });
    const reader = new ByteReader(payload);
    reader.readUTF();
    reader.readInt();
    reader.readInt();
    reader.readInt();
    reader.readUTF();
    expect(reader.readBoolean()).toBe(false);
    reader.readUTF();
    return reader.readUTF();
  }

  it("同一房间身份种子在每个中继跳按当前 serverUuid 派生", () => {
    const firstHop = registeredClientId("relay-hop-a");
    const secondHop = registeredClientId("relay-hop-b");
    expect(firstHop).toBe(sha256Hex("room-stable-seedrelay-hop-a").toUpperCase());
    expect(secondHop).toBe(sha256Hex("room-stable-seedrelay-hop-b").toUpperCase());
    expect(secondHop).not.toBe(firstHop);
    expect(registeredClientId("relay-hop-a")).toBe(firstHop);
  });
});

describe("extraCheck / formatServerCode", () => {
  it("h(i) = #%06X（真实客户端实测格式）", () => {
    expect(extraCheckString(6789)).toBe("#001A85"); // 2026-09 真实原版客户端抓包值
    expect(extraCheckString(0)).toBe("#000000");
    expect(extraCheckString(16777215)).toBe("#FFFFFF");
    expect(extraCheckString(-1)).toBe("#FFFFFF");
  });
  it("低段位代码 = md5 截断", () => {
    expect(formatServerCode(1234)).toBe(md5Hex("x1234").slice(0, 10));
    expect(formatServerCode(150000)).toBe(md5Hex("y150000").slice(0, 11));
    expect(formatServerCode(250000)).toBe(md5Hex("z250000").slice(0, 12));
  });
  it("高段位代码内嵌 g()", () => {
    const code = formatServerCode(500000);
    expect(code).toBe(md5Hex("xx500000").slice(0, 13) + "-" + integrityString(200000));
  });
  it("0 与越界", () => {
    expect(formatServerCode(0)).toBe("");
    expect(formatServerCode(-5)).toBe("NA");
    expect(formatServerCode(5000000)).toBe("NA");
  });
});

describe("帧编解码", () => {
  it("encode → decode 往返", () => {
    const payload = new ByteWriter().writeUTF("hi").writeInt(-1).toBuffer();
    const frame = encodeFrame(140, payload);
    // 头部：len=8+... payload 长度, type=140
    expect(frame.readInt32BE(0)).toBe(payload.length);
    expect(frame.readInt32BE(4)).toBe(140);
    const dec = new FrameDecoder();
    const frames = dec.feed(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(140);
    expect(frames[0]!.payload.equals(payload)).toBe(true);
  });

  it("分块到达与粘包", () => {
    const a = encodeFrame(108, Buffer.from([1, 2, 3]));
    const b = encodeFrame(109, Buffer.alloc(300, 0xab));
    const stream = Buffer.concat([a, b]);
    const dec = new FrameDecoder();
    expect(dec.feed(stream.subarray(0, 5))).toHaveLength(0);
    // 帧a共11字节，累计到20字节时完成
    expect(dec.feed(stream.subarray(5, 20)).map((f) => f.type)).toEqual([108]);
    const got = dec.feed(stream.subarray(20));
    expect(got.map((f) => f.type)).toEqual([109]);
    expect(got[0]!.payload.length).toBe(300);
  });

  it("拒绝负长度", () => {
    const dec = new FrameDecoder();
    const bad = Buffer.alloc(8);
    bad.writeInt32BE(-1, 0);
    bad.writeInt32BE(1, 4);
    expect(() => dec.feed(bad)).toThrow(/negative/);
  });
});

describe("StreamBlock", () => {
  it("写→读→跳过对齐", () => {
    const w = new ByteWriter();
    writeBlock(w, "teams", Buffer.from([1, 2, 3]));
    w.writeInt(42);
    const r = new ByteReader(w.toBuffer());
    const blk = readBlock(r);
    expect(blk.name).toBe("teams");
    expect([...blk.data]).toEqual([1, 2, 3]);
    expect(r.readInt()).toBe(42);

    // skipBlock 版本
    const r2 = new ByteReader(w.toBuffer());
    expect(skipBlock(r2)).toBe("teams");
    expect(r2.readInt()).toBe(42);
  });

  it("gzip 块数据按需解压", () => {
    const raw = Buffer.from("无头客户端".repeat(50));
    const gz = gzipSync(raw);
    const w = new ByteWriter();
    writeBlock(w, "customUnits", gz);
    const r = new ByteReader(w.toBuffer());
    const blk = readBlock(r);
    expect(gunzipSync(blk.data).equals(raw)).toBe(true);
  });
});
