#!/usr/bin/env node
/**
 * 聊天收发往返自检：同一房间开两条连接（listener + sender），
 * sender 发一条带随机标记的消息，listener 若听到即 140 发送 / 141 广播全链路正常。
 *
 * 用法：npx tsx tools/chat-loopback.ts <target>     如 rkz198 / list:0 / 1.2.3.4:5123
 * 退出码：0 = 往返成功；1 = 超时未听到；2 = 进房/目标失败
 */
import { Session } from "../src/client/session.ts";
import { listRooms, roomConnectDescriptor } from "../src/masterserver/client.ts";
import { parseConnectTarget, resolveTarget, TargetError } from "../src/masterserver/target.ts";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: npx tsx tools/chat-loopback.ts <target>");
  process.exit(2);
}

const MARK = `loopback-${Date.now().toString(36)}`;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function waitBattleroom(s: Session, label: string, ms = 15000): Promise<void> {
  if (s.state === "battleroom") return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 进房超时 (state=${s.state})`)), ms);
    s.on("stateChange", (st) => {
      if (st === "battleroom") { clearTimeout(t); resolve(); }
    });
    s.on("disconnected", (r) => { clearTimeout(t); reject(new Error(`${label} 断开: ${r}`)); });
  });
}

try {
  const target = await resolveTarget(parseConnectTarget(raw), null);
  log(`目标: ${target.label}`);

  let heard = false;
  const listener = new Session(target, { playerName: "rw-listener", clientUuid: "rw-loopback-A" });
  listener.on("chat", (c) => {
    if (c.senderName === "rw-sender" && c.message.includes(MARK)) {
      heard = true;
      log(`✔ 听到回传: <${c.senderName}> ${c.message}`);
    }
  });
  listener.on("log", (l) => log(`[listener] ${l}`));
  await listener.start();
  await waitBattleroom(listener, "listener");

  const sender = new Session(target, { playerName: "rw-sender", clientUuid: "rw-loopback-B" });
  sender.on("log", (l) => log(`[sender] ${l}`));
  await sender.start();
  await waitBattleroom(sender, "sender");

  log(`发送标记消息: ${MARK}`);
  if (!sender.sendChat(`自检消息 ${MARK}`)) throw new Error("sendChat 返回 false");

  const deadline = Date.now() + 10000;
  while (!heard && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

  listener.disconnect("selfcheck done");
  sender.disconnect("selfcheck done");
  log(heard ? "PASS：发送 → 服务器广播 → 接收 全链路正常" : "FAIL：10 秒内未听到回传消息");
  process.exit(heard ? 0 : 1);
} catch (err) {
  if (err instanceof TargetError) console.error(`目标错误: ${err.message}`);
  else console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}
