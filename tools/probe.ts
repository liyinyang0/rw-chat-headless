#!/usr/bin/env node
/** 探针：连目标，发 160 hello，把收到的每个帧按 hex 转储（用于分析非标准服务器）。 */
import { Socket } from "node:net";
import { FrameDecoder, encodeFrame } from "../src/protocol/frame.ts";
import { buildHello } from "../src/protocol/packets/common.ts";
import { solvePowChallenge, parsePowChallenge, buildPowResponse } from "../src/protocol/packets/pow.ts";
import { PacketType } from "../src/protocol/packets/common.ts";
import { buildRegister } from "../src/protocol/packets/common.ts";

const target = process.argv[2] ?? "r.relay.corrodinggames.com:5123";
const code = process.argv[3] ?? "";
const [host, portStr] = target.split(":");
const name = process.env.NAME ?? "probe";

const sock = new Socket();
const dec = new FrameDecoder();
let info: { networkVersion: number; sessionRandomId: number | null; integritySalt: number | null } | null = null;

sock.connect(Number(portStr ?? 5123), host, () => {
  console.log(`connected ${host}:${portStr}`);
  sock.write(encodeFrame(PacketType.PREREGISTER_REQUEST, buildHello({ playerName: name, queryString: code || null })));
});
sock.on("data", (chunk) => {
  for (const f of dec.feed(chunk)) {
    console.log(`\n<- type=${f.type} len=${f.payload.length}`);
    console.log(f.payload.toString("hex").replace(/(.{64})/g, "$1\n"));
    console.log("utf8:", JSON.stringify(f.payload.subarray(0, 200).toString("utf8").replace(/[^\x20-\x7e]/g, ".")));
    if (f.type === 161) {
      // 解析 netVer/seed 供注册
      try {
        const r = new (require("../src/protocol/primitives.ts").ByteReader)(f.payload);
        r.readUTF(); const rv = r.readInt(); const nv = r.readInt(); r.readInt(); r.readUTF(); r.readUTF();
        let seed: number | null = null, salt: number | null = null;
        if (rv >= 1) seed = r.readInt();
        if (rv >= 2) { salt = r.readInt(); r.readInt(); }
        info = { networkVersion: nv, sessionRandomId: seed, integritySalt: salt };
        console.log(`[probe] 161: responseVer=${rv} netVer=${nv} seed=${seed} salt=${salt}`);
      } catch (e) { console.log("[probe] 161 parse fail", e); }
      const reg = buildRegister({ playerName: name, networkVersion: info?.networkVersion ?? 0, formatVersion: 5, sessionRandomId: info?.sessionRandomId, integritySalt: info?.integritySalt });
      sock.write(encodeFrame(PacketType.REGISTER_PLAYER, reg));
      console.log(`-> 110 register (netVer=${info?.networkVersion})`);
    }
    if (f.type === 151) {
      const c = parsePowChallenge(f.payload);
      const answer = solvePowChallenge(c);
      console.log(`[probe] pow type=${c.type} answer=${answer.slice(0, 40)}`);
      sock.write(encodeFrame(PacketType.RELAY_POW_RECEIVE, buildPowResponse(c.id, c.type, answer, 0.01)));
      if (info) {
        sock.write(encodeFrame(PacketType.REGISTER_PLAYER, buildRegister({ playerName: name, networkVersion: info.networkVersion, formatVersion: 5, sessionRandomId: info.sessionRandomId, integritySalt: info.integritySalt })));
        console.log("-> 110 register (re-send after pow)");
      }
    }
  }
});
sock.on("error", (e) => console.log("error:", e.message));
setTimeout(() => { console.log("\n[probe] done"); process.exit(0); }, Number(process.env.WAIT ?? 12000));
