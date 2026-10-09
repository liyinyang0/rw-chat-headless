#!/usr/bin/env node
/**
 * 透明抓包代理：真实 RW 客户端 ⇄ 本代理 ⇄ r 码中继链，双向逐帧记录。
 * 用途：捕获开局(120)后真客户端实际发送的"加载完成"信号。
 *
 * 用法：npx tsx tools/proxy-capture.ts [listenPort] [entryHost:port] [roomCode]
 * 默认：5123  r.relay.corrodinggames.com:5123  roomCode 必填（如 r50699）
 * 客户端侧：IP 栏直接连 127.0.0.1（端口即 listenPort）
 *
 * 原理：
 *  - 首跳把 160 hello 的 query 注入为 roomCode（IP 直连时客户端 query 为空）
 *  - 收到 178 重定向时改写目标为 127.0.0.1:listenPort 并记住真实上游，
 *    客户端回连代理 → 代理再连真实节点，跳转全程不脱离代理
 *  - 其余帧逐帧转发（帧头确定性重编码，载荷不动）
 */
import { createConnection, createServer } from "node:net";
import { FrameDecoder, encodeFrame } from "../src/protocol/frame.ts";
import { ByteWriter } from "../src/protocol/primitives.ts";
import { parsePasswordRequest, buildPasswordResponse } from "../src/protocol/packets/common.ts";

const listenPort = Number(process.argv[2] ?? 5123);
const entry = process.argv[3] ?? "r.relay.corrodinggames.com:5123";
const roomCode = process.argv[4] ?? "";
if (!roomCode) {
  console.error("用法: npx tsx tools/proxy-capture.ts [listenPort] [entryHost:port] <roomCode>");
  process.exit(1);
}
const [entryHost, entryPortStr] = entry.split(":");
const entryPort = Number(entryPortStr ?? 5123);

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

/** 178 改写后等待客户端回连的真实上游队列。 */
const pendingUpstreams: string[] = [];

/** 160 hello: [UTF magic][i32 reqVer][i32 netVer][i32 platform][nullable query][playerName…] → 替换 query */
function rewriteHelloQuery(payload: Buffer, query: string | null): Buffer {
  let p = 0;
  const mlen = payload.readUInt16BE(p);
  p += 2 + mlen;
  const headEnd = p + 12; // 三个 i32
  p = headEnd;
  const hasQ = payload.readUInt8(p);
  p += 1;
  if (hasQ) {
    const qlen = payload.readUInt16BE(p);
    p += 2 + qlen;
  }
  const queryField = new ByteWriter().writeStringNullable(query).toBuffer();
  return Buffer.concat([payload.subarray(0, headEnd), queryField, payload.subarray(p)]);
}

function rewriteRedirect(payload: Buffer): { buf: Buffer; target: string } {
  const text = payload.toString("latin1");
  const m = text.match(/\[TCP\]([^\s\x00]+)/) ?? text.match(/([0-9a-zA-Z.\-]+:\d+)/);
  if (!m) return { buf: payload, target: "" };
  const replaced = text.replace(m[0]!, `[TCP]127.0.0.1:${listenPort}`);
  return { buf: Buffer.from(replaced, "latin1"), target: m[1]! };
}

/** S→C 方向值得打日志的包（10/30/108/109/115 等高频同步帧跳过）。 */
function s2cInteresting(type: number): boolean {
  return [106, 111, 112, 117, 120, 122, 141, 150, 151, 161, 163, 178].includes(type);
}

let connSeq = 0;
const server = createServer((client) => {
  const id = ++connSeq;
  // 跳转链上的回连（178 改写产生）：160 不带 query，117 由代理代答房间码
  const fromRedirect = pendingUpstreams.length > 0;
  const upstreamAddr = pendingUpstreams.shift() ?? `${entryHost}:${entryPort}`;
  const [upHost, upPortStr] = upstreamAddr.split(":");
  log(`#${id} 客户端接入 → 上游 ${upstreamAddr}${fromRedirect ? "（跳转链回连）" : ""}`);
  const up = createConnection({ host: upHost!, port: Number(upPortStr ?? 5123) });

  const cDec = new FrameDecoder();
  const sDec = new FrameDecoder();
  let helloRewritten = false;
  let gameStarted = false;
  let c2sAfterStart = 0;

  const teardown = (why: string) => {
    log(`#${id} 连接结束（${why}）${gameStarted ? `；开局后 C→S 共 ${c2sAfterStart} 帧` : ""}`);
    client.destroy();
    up.destroy();
  };
  client.on("error", (e) => teardown(`客户端错误 ${e.message}`));
  up.on("error", (e) => teardown(`上游错误 ${e.message}`));
  client.on("close", () => teardown("客户端断开"));
  up.on("close", () => teardown("上游断开"));

  client.on("data", (chunk) => {
    try {
      let out = Buffer.alloc(0);
      for (const f of cDec.feed(chunk)) {
        let payload = f.payload;
        const star = gameStarted ? "★" : " ";
        log(`#${id} C→S${star} type=${f.type} len=${f.payload.length}` + (f.payload.length <= 96 ? ` hex=${f.payload.toString("hex")}` : ""));
        if (gameStarted) c2sAfterStart++;
        if (!helloRewritten && f.type === 160) {
          payload = rewriteHelloQuery(payload, fromRedirect ? null : roomCode);
          helloRewritten = true;
          log(`#${id}    ↳ 160 query → ${fromRedirect ? "null（跳转链，等 117 问 ID）" : roomCode}`);
        }
        out = Buffer.concat([out, encodeFrame(f.type, payload)]);
      }
      up.write(out);
    } catch (e) {
      log(`#${id} C→S 解码异常，原样转发本块: ${e instanceof Error ? e.message : e}`);
      up.write(chunk);
    }
  });

  up.on("data", (chunk) => {
    try {
      let out = Buffer.alloc(0);
      for (const f of sDec.feed(chunk)) {
        let payload = f.payload;
        if (fromRedirect && f.type === 117) {
          // 节点问房间 ID：代理代答，不转发给客户端（客户端不知道房间码上下文）
          try {
            const req = parsePasswordRequest(f.payload);
            up.write(encodeFrame(118, buildPasswordResponse(req.requestId, roomCode)));
            log(`#${id} S→C 117（${req.prompt.replace(/\n/g, " ").slice(0, 40)}）→ 代理已代答 118=${roomCode}`);
          } catch {
            log(`#${id} S→C 117 解析失败，原样转发`);
            out = Buffer.concat([out, encodeFrame(f.type, payload)]);
          }
          continue;
        }
        if (f.type === 178) {
          const r = rewriteRedirect(f.payload);
          if (r.target) {
            pendingUpstreams.push(r.target);
            payload = r.buf;
            log(`#${id} S→C 178 重定向 ${r.target} → 改写为 127.0.0.1:${listenPort}（客户端将回连代理）`);
          }
        }
        if (f.type === 120 && !gameStarted) {
          gameStarted = true;
          log(`#${id} ══ 收到开局(120) — 之后带 ★ 的 C→S 帧即加载应答序列 ══`);
        }
        if (s2cInteresting(f.type)) {
          log(`#${id} S→C type=${f.type} len=${f.payload.length}` + (f.payload.length <= 64 ? ` hex=${f.payload.toString("hex")}` : ""));
        }
        out = Buffer.concat([out, encodeFrame(f.type, payload)]);
      }
      client.write(out);
    } catch (e) {
      log(`#${id} S→C 解码异常，原样转发本块: ${e instanceof Error ? e.message : e}`);
      client.write(chunk);
    }
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  log(`监听 127.0.0.1:${listenPort} — 真实客户端 IP 栏直连 127.0.0.1 即可`);
  log(`入口 ${entry}，注入房间码 ${roomCode}；178 重定向将自动改写回代理`);
});
