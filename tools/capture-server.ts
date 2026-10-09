#!/usr/bin/env node
/**
 * 抓包辅助：监听一个端口，把真实 RW 客户端发来的前几个帧解出关键字段。
 * 用途：从真客户端提取核心单位校验和（110 包字段 9）。
 *
 * 用法：
 *   npx tsx tools/capture-server.ts [port]        # 默认 5123
 * 然后在 RW/RWX 客户端里直接连接 127.0.0.1:<port>
 */
import { createServer } from "node:net";
import { FrameDecoder, encodeFrame } from "../src/protocol/frame.ts";
import { ByteReader, ByteWriter } from "../src/protocol/primitives.ts";
import { integrityString } from "../src/protocol/integrity.ts";

const port = Number(process.argv[2] ?? 5123);
const server = createServer((socket) => {
  console.log(`[capture] 客户端已连接: ${socket.remoteAddress}`);
  const dec = new FrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = dec.feed(chunk);
    } catch {
      return;
    }
    for (const frame of frames) {
      console.log(`[capture] -> type=${frame.type} len=${frame.payload.length}`);
      if (frame.type === 160) {
        // 回一个合成 161，诱使客户端发出 110（内含校验和）
        const w = new ByteWriter();
        w.writeUTF("com.corrodinggames.rts");
        w.writeInt(2); // responseVersion
        w.writeInt(176); // networkVersion
        w.writeInt(176); // versionCode
        w.writeUTF("com.corrodinggames.rts.java");
        w.writeUTF("capture-server-00000001");
        w.writeInt(12345); // sessionRandomId
        w.writeInt(6789); // integritySalt
        w.writeInt(0);
        socket.write(encodeFrame(161, w.toBuffer()));
        console.log("  [capture] <- 已回合成 161");
      }
      if (frame.type === 110) {
        const r = new ByteReader(frame.payload);
        const magic = r.readUTF();
        const format = r.readInt();
        const netVer = r.readInt();
        const versionCode = r.readInt();
        const name = r.readUTF();
        const hasPassword = r.readBoolean();
        if (hasPassword) r.readUTF();
        if (format >= 1) r.readUTF();
        if (format >= 2) r.readUTF();
        let checksum: number | null = null;
        let integrity: string | null = null;
        let extra: string | null = null;
        if (format >= 3) checksum = r.readInt();
        if (format >= 4) integrity = r.readUTF();
        if (format >= 5) extra = r.readUTF();
        console.log("  [110] magic=%s format=%d netVer=%d versionCode=%d name=%s", magic, format, netVer, versionCode, name);
        if (integrity !== null) {
          console.log(`  ★ g(12345) 真实客户端 = ${integrity}`);
          const mine = integrityString(12345);
          console.log(`  ★ g(12345) 我的实现   = ${mine}`);
          console.log(`  ★ ${mine === integrity ? "一致 ✓" : "不一致 ✗ —— 公式有差异！"}`);
        }
        if (extra !== null) console.log(`  ★ h(6789) = ${extra}`);
        if (checksum !== null) {
          console.log(`\n  ★ 核心单位校验和 = ${checksum} (0x${(checksum >>> 0).toString(16)})`);
        }
      }
    }
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[capture] 监听 127.0.0.1:${port} — 请用真实游戏客户端连接此地址`);
});
