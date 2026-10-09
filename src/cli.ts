#!/usr/bin/env node
/**
 * rw-chat-headless CLI
 *
 * 用法：
 *   npx tsx src/cli.ts list                          # 列出公开房间
 *   npx tsx src/cli.ts join <target>                 # 进房（stdin 聊天）
 *   npx tsx src/cli.ts join-multi <t1> <t2> …        # 单进程同时进多个房
 *
 * target 支持：房间代码（rkzxxxx）/ host:port / get|id|code|pwd|port / 列表序号（list:3）
 * 环境变量：NAME（玩家名，默认 rw-chat-headless）、PASSWORD、LANGUAGE、REGISTER_FORMAT、
 *           CLIENT_UUID、UNITS_CHECKSUM、RELAY_ROOM_ID、RW_SOCKS_PROXY、DEBUG
 */
import { createInterface } from "node:readline";
import { listRooms, roomConnectDescriptor } from "./masterserver/client.ts";
import { parseConnectTarget, resolveTarget, TargetError } from "./masterserver/target.ts";
import { Session, type SessionOptions } from "./client/session.ts";
import { ReconnectingSession, type ReconnectOptions } from "./client/reconnecting.ts";
import { DEFAULT_UNITS_CHECKSUM } from "./protocol/packets/common.ts";
import { runMultiRooms, type MultiRunResult } from "./client/multi.ts";
import { parseSocksProxy } from "./client/connection.ts";

const env = process.env;
const NAME = env.NAME || "rw-chat-headless";
const SOCKS_PROXY = parseSocksProxy(env.RW_SOCKS_PROXY);

function numericEnv(key: string, fallback: number): number {
  const value = Number(env[key] || fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key}`);
  return value;
}

function reconnectOptions(): ReconnectOptions {
  return { enabled: env.AUTO_RECONNECT === "1", maxRetries: numericEnv("RECONNECT_MAX_RETRIES", 10),
    baseDelayMs: numericEnv("RECONNECT_BASE_MS", 5000), maxDelayMs: numericEnv("RECONNECT_MAX_MS", 60000) };
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function info(msg: string) {
  console.log(`[${ts()}] ${msg}`);
}

/** list:3 之类的序号引用 → 描述符。 */
async function expandTarget(raw: string): Promise<string> {
  const listMatch = raw.match(/^list:(-?\d+)$/);
  if (listMatch) {
    const idx = Number(listMatch[1]);
    const rooms = await listRooms();
    const room = rooms[idx];
    if (!room) throw new TargetError(`list index ${idx} out of range (0..${rooms.length - 1})`);
    info(`选中列表房间: ${describeRoom(room, idx)}`);
    return roomConnectDescriptor(room);
  }
  return raw;
}

function describeRoom(r: { createdBy: string; mapPath: string; currentPlayers: number; maxPlayers: number; gameState: string; requiresPassword: boolean; hasMods: boolean; gameVersionCode?: number }, idx: number): string {
  const map = (r.mapPath || "?").split("/").pop();
  const flags = [r.requiresPassword ? "🔒" : "", r.hasMods ? "mod" : "", r.gameVersionCode ? `v${r.gameVersionCode}` : ""].filter(Boolean).join(" ");
  return `#${idx} ${r.createdBy} | ${map} | ${r.currentPlayers}/${r.maxPlayers} | ${r.gameState} ${flags}`;
}

async function cmdList(): Promise<void> {
  info("正在从主服务器拉取房间列表…");
  const rooms = await listRooms();
  if (rooms.length === 0) {
    info("没有公开房间");
    return;
  }
  console.log(`共 ${rooms.length} 个房间：`);
  rooms.forEach((r, i) => console.log(describeRoom(r, i)));
  console.log("\n进入方式：npx tsx src/cli.ts join list:<序号>");
}

async function runSession(target: string): Promise<void> {
  const expanded = await expandTarget(target);
  const parsed = parseConnectTarget(expanded);
  info(`目标: ${expanded}`);
  const options: SessionOptions = {
    playerName: NAME,
    password: env.PASSWORD || null,
    language: env.LANGUAGE || "zh",
    // v176 系（Rukkit/RW-HPS/RWX）要求完整注册；i2=2 会被静默丢弃
    formatVersion: (env.REGISTER_FORMAT === "2" ? 2 : 5) as 2 | 5,
    unitsChecksum: Number(env.UNITS_CHECKSUM || DEFAULT_UNITS_CHECKSUM) | 0,
    relayRoomId: env.RELAY_ROOM_ID || null,
    debugFrames: env.DEBUG === "1" || env.DEBUG === "true",
    clientUuid: env.CLIENT_UUID || undefined,
    socksProxy: SOCKS_PROXY,
    joinTimeoutMs: numericEnv("JOIN_TIMEOUT_MS", 45000),
    receiveTimeoutMs: numericEnv("RECEIVE_TIMEOUT_MS", 60000),
  };
  const retry = reconnectOptions();
  const session = retry.enabled ? new ReconnectingSession(expanded, options, retry)
    : new Session(await resolveTarget(parsed, env.PASSWORD || null), options);
  session.on("log", (line) => info(line));

  session.on("chat", (chat) => {
    const sender = chat.senderName ?? "<server>";
    console.log(`  ${sender}: ${chat.message}`);
  });

  session.on("stateChange", (state) => {
    if (state === "battleroom" && session.info) {
      info(`已在战役室，serverUuid=${session.info.serverUuid}`);
    }
  });

  session.on("kicked", (reason) => info(`被踢出: ${reason}`));
  session.on("disconnected", (reason) => info(`连接断开: ${reason}`));
  session.on("inputRequest", (request) => {
    info(`服务器请求输入: ${request.prompt}`);
    info("下一行输入将作为应答；/quit 退出。");
  });

  // stdin 聊天
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "/quit" || text === "/exit") {
      session.disconnect("bye");
      setTimeout(() => process.exit(0), 300);
      return;
    }
    if (session.pendingInputRequest) {
      session.pendingInputRequest.respond(line);
      return;
    }
    if (!text) return;
    session.sendChat(text);
  });

  let startupFailed = false;
  rl.on("close", () => {
    if (startupFailed) return;
    session.disconnect("stdin closed");
    setTimeout(() => process.exit(0), 300);
  });
  try {
    await session.start();
  } catch (error) {
    startupFailed = true;
    rl.close();
    throw error;
  }

  // 保持进程
  await new Promise<void>(() => {});
}

function dumpRooms(run: MultiRunResult): void {
  for (const h of run.handles) {
    const s = h.snapshot();
    info(
      `#${s.index + 1} [${s.state}] ${s.label} | ${s.name} | roomId=${s.roomId} | 玩家=${s.currentPlayers}` +
        (s.error ? ` | ${s.error}` : ""),
    );
  }
}

/**
 * 单进程多房间：join-multi list:0 list:2 …（参数也支持逗号分隔）。
 * 环境变量：MULTI_NAME（suffix|same，默认 suffix）、MULTI_STAGGER_MS、
 *           MULTI_LIFETIME_MS（到时自动退出）。
 */
async function runMultiSession(targetArgs: string[]): Promise<void> {
  const lifetimeMs = Number(env.MULTI_LIFETIME_MS || 0);
  const run = await runMultiRooms({
    targets: targetArgs,
    playerName: NAME,
    password: env.PASSWORD || null,
    language: env.LANGUAGE || "zh",
    formatVersion: (env.REGISTER_FORMAT === "2" ? 2 : 5) as 2 | 5,
    unitsChecksum: Number(env.UNITS_CHECKSUM || DEFAULT_UNITS_CHECKSUM) | 0,
    relayRoomId: env.RELAY_ROOM_ID || null,
    nameStrategy: env.MULTI_NAME === "same" ? "same" : "suffix",
    clientIdBase: env.CLIENT_UUID || undefined,
    staggerMs: Number(env.MULTI_STAGGER_MS || 1200),
    debugFrames: env.DEBUG === "1" || env.DEBUG === "true",
    socksProxy: SOCKS_PROXY,
    joinTimeoutMs: numericEnv("JOIN_TIMEOUT_MS", 45000),
    receiveTimeoutMs: numericEnv("RECEIVE_TIMEOUT_MS", 60000),
    reconnect: reconnectOptions(),
    log: info,
  });

  dumpRooms(run);

  const shutdown = (sig: string) => {
    info(`收到 ${sig}，退出全部房间…`);
    void run.close().then(() => setTimeout(() => process.exit(0), 300));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // stdin 命令：/rooms /say <序号> <文本> /sayall <文本> /quit
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/quit" || text === "/exit") return shutdown("/quit");
    if (text === "/rooms") return dumpRooms(run);
    const say = text.match(/^\/say\s+(\d+)\s+([\s\S]+)$/);
    if (say) {
      const h = run.handles[Number(say[1]) - 1];
      if (!h) return info(`没有 #${say[1]} 房间`);
      h.sendChat(say[2]!);
      info(`[#${say[1]}] ${h.name}: ${say[2]}`);
      return;
    }
    const sayall = text.match(/^\/sayall\s+([\s\S]+)$/);
    if (sayall) {
      for (const h of run.handles) {
        if (h.state() === "battleroom") h.sendChat(sayall[1]!);
      }
      info(`已向全部战役室发送: ${sayall[1]}`);
      return;
    }
    info("命令: /rooms | /say <序号> <文本> | /sayall <文本> | /quit");
  });
  rl.on("close", () => info("stdin 已关闭（多房模式不自动退出；/quit 或 SIGINT 退出）"));

  if (lifetimeMs > 0) {
    setTimeout(() => {
      info(`MULTI_LIFETIME_MS=${lifetimeMs} 到时，自动退出…`);
      dumpRooms(run);
      void run.close().then(() => setTimeout(() => process.exit(0), 300));
    }, lifetimeMs).unref();
  }

  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "list") return await cmdList();
    if (cmd === "join" && rest[0]) {
      return await runSession(rest.join(" "));
    }
    if (cmd === "join-multi" && rest.length > 0) {
      return await runMultiSession(rest);
    }
  } catch (err) {
    if (err instanceof TargetError) {
      console.error(`目标错误: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  console.log(`用法:
  npx tsx src/cli.ts list                 拉取公开房间列表
  npx tsx src/cli.ts join <target>        进房（终端手动聊天）
  npx tsx src/cli.ts join-multi <t...>    单进程同时进多个房

target:
  list:<序号>        列表房间（先跑 list 看序号）
  <房间代码>         如 rkzxxxx → 首字母中继
  <host>[:port]      直连 IP/域名，默认端口 5123
  get|id|code|pwd|port   完整描述符

join-multi 额外环境变量: MULTI_NAME(suffix|same) MULTI_STAGGER_MS MULTI_LIFETIME_MS
  stdin 命令: /rooms /say <序号> <文本> /sayall <文本> /quit

环境变量: NAME PASSWORD LANGUAGE REGISTER_FORMAT CLIENT_UUID UNITS_CHECKSUM RELAY_ROOM_ID RW_SOCKS_PROXY DEBUG`);
  process.exit(1);
}

void main();
