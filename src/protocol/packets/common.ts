import { ByteReader, ByteWriter } from "../primitives.ts";
import { extraCheckString, integrityString } from "../integrity.ts";
import { rwSha256Hex } from "../hashes.ts";
import { persistentClientUuid } from "../identity.ts";

/** 帧类型常量（对齐 RW PacketType）。 */
export const PacketType = {
  SERVER_COMMAND: 4,
  CHAT: 140,
  CHAT_RECEIVE: 141,
  DISCONNECT: 111,
  CLIENT_STATUS: 112,
  PASSWORD_ERROR: 113,
  TEAM_LIST: 115,
  HEART_BEAT: 108,
  HEART_BEAT_RESPONSE: 109,
  KICK: 150,
  RELAY_117: 117,
  RELAY_118: 118,
  RELAY_POW: 151,
  RELAY_POW_RECEIVE: 152,
  PREREGISTER_REQUEST: 160,
  PREREGISTER_INFO: 161,
  REGISTER_PLAYER: 110,
  /** 原版 PACKET_RECONNECT_TO：结构化连接字符串列表。 */
  RELAY_REDIRECT: 178,
} as const;

export const MAGIC = "com.corrodinggames.rts";

/** 平台码：1=安卓，2=PC，3=iOS（NetworkEngine.f）。 */
export const PLATFORM_PC = 2;

/** 本客户端实现的协议/构建版本（RW 1.15 系 = 176）。 */
export const VERSION_CODE = 176;
export const DEFAULT_UNITS_CHECKSUM = 678359601;

export interface HelloOptions {
  playerName: string;
  language?: string;
  /** 中继/转发场景的查询串（如房间代码 rkzxxxx）。 */
  queryString?: string | null;
  platform?: number;
  networkVersion?: number;
}

/** 160 PREREGISTER_REQUEST（客户端→服务器，连接后第一包）。 */
export function buildHello(opts: HelloOptions): Buffer {
  const w = new ByteWriter();
  w.writeUTF(MAGIC);
  w.writeInt(4); // requestVersion
  w.writeInt(opts.networkVersion ?? VERSION_CODE);
  w.writeInt(opts.platform ?? PLATFORM_PC);
  w.writeStringNullable(opts.queryString ?? null);
  w.writeUTF(opts.playerName);
  w.writeUTF(opts.language ?? "en");
  w.writeUTF(""); // flags：自动化测试客户端会写 "d"，正常留空
  return w.toBuffer();
}

export interface PreregisterInfo {
  /** 服务器网络版本，用于解析其后续流；不是客户端支持的版本。 */
  networkVersion: number;
  serverUuid: string;
  /** 完整性挑战种子（i2>=5 模式需要）。 */
  sessionRandomId: number | null;
  /** 额外校验回显值。 */
  integritySalt: number | null;
  extraEcho: number | null;
  packageName: string;
  versionCode: number;
}

/** 161 PREREGISTER_INFO（服务器→客户端）。 */
export function parsePreregisterInfo(payload: Buffer): PreregisterInfo {
  const r = new ByteReader(payload);
  r.readUTF(); // magic
  const responseVersion = r.readInt();
  const networkVersion = r.readInt();
  const versionCode = r.readInt();
  const packageName = r.readUTF();
  const serverUuid = r.readUTF();
  let sessionRandomId: number | null = null;
  let integritySalt: number | null = null;
  let extraEcho: number | null = null;
  if (responseVersion >= 1) sessionRandomId = r.readInt();
  if (responseVersion >= 2) {
    integritySalt = r.readInt();
    extraEcho = r.readInt();
  }
  return { networkVersion, serverUuid, sessionRandomId, integritySalt, extraEcho, packageName, versionCode };
}

export interface RegisterOptions {
  playerName: string;
  /** 客户端支持的网络版本；不得通过回显 161 来假装跨版本兼容。 */
  networkVersion: number;
  /** 房间密码（sha256 后发送）。 */
  password?: string | null;
  /** 注册格式版本：5=完整指纹（v176 系要求）；2=老客户端精简格式。 */
  formatVersion?: 2 | 5;
  /** 已完成派生的最终客户端 ID；仅供协议探针等低层调用覆盖。 */
  clientId?: string;
  /** 客户端持久 UUID 种子；最终 ID 按当前一跳 serverUuid 派生。 */
  clientUuid?: string;
  /** 161 的 serverUuid，用于派生 clientId。 */
  serverUuid?: string | null;
  /** i2>=5 模式需要的 161 数据。 */
  sessionRandomId?: number | null;
  integritySalt?: number | null;
  /** 核心单位校验和（服务器按自身版本校验；Rukkit/RW-HPS 不校验，0 可过）。 */
  unitsChecksum?: number;
}

/** 110 REGISTER_PLAYER（客户端→服务器）。 */
export function buildRegister(opts: RegisterOptions): Buffer {
  const format = opts.formatVersion ?? 5;
  const w = new ByteWriter();
  w.writeUTF(MAGIC);
  w.writeInt(format);
  w.writeInt(opts.networkVersion);
  w.writeInt(VERSION_CODE);
  w.writeUTF(opts.playerName);
  w.writeStringNullable(opts.password != null ? rwSha256Hex(opts.password) : null);
  if (format >= 1) w.writeUTF("com.corrodinggames.rts.java"); // connectionLabel：PC 桌面客户端包名（.server 会被中继误判为节点级联）
  if (format >= 2) w.writeUTF(opts.clientId ?? deriveClientId(opts.serverUuid, opts.clientUuid));
  if (format >= 3) w.writeInt(opts.unitsChecksum ?? DEFAULT_UNITS_CHECKSUM);
  if (format >= 4) w.writeUTF(integrityString(opts.sessionRandomId ?? 0));
  if (format >= 5) w.writeUTF(extraCheckString(opts.integritySalt ?? 0));
  return w.toBuffer();
}

/** 模拟真实客户端：每一跳都按当前 serverUuid 派生最终 ID。 */
function deriveClientId(serverUuid?: string | null, clientUuid?: string): string {
  const stableUuid = clientUuid || process.env.CLIENT_UUID || persistentClientUuid();
  return rwSha256Hex(stableUuid + (serverUuid ?? ""));
}

/** 140 CHAT（客户端→服务器）。 */
export function buildChat(message: string): Buffer {
  const w = new ByteWriter();
  w.writeUTF(message);
  w.writeByte(0);
  return w.toBuffer();
}

export interface ChatMessageReceived {
  message: string;
  formatVersion: number;
  senderName: string | null;
  senderConnectionId: number;
  senderTeamId: number | null;
}

/** 141 CHAT_RECEIVE（服务器→客户端）。 */
export function parseChatReceive(payload: Buffer): ChatMessageReceived {
  const r = new ByteReader(payload);
  const message = r.readUTF();
  const formatVersion = r.readUnsignedByte();
  const senderName = r.readNullableString();
  const senderConnectionId = r.readInt();
  let senderTeamId: number | null = null;
  if (formatVersion >= 3) senderTeamId = r.readInt();
  return { message, formatVersion, senderName, senderConnectionId, senderTeamId };
}

/** 108 HEART_BEAT（客户端→服务器）。 */
export function buildHeartBeat(): Buffer {
  const w = new ByteWriter();
  w.writeLong(BigInt(Date.now()));
  w.writeByte(0);
  return w.toBuffer();
}

/** 109 应答（收到服务器的 108 时回）。fps 钳制 ≤130。 */
export function buildHeartBeatResponse(echoTimestamp: bigint, fps = 60): Buffer {
  const w = new ByteWriter();
  w.writeLong(echoTimestamp);
  w.writeByte(1);
  w.writeByte(Math.min(fps, 130));
  return w.toBuffer();
}

/** 解析 108（服务器也可能主动 ping 客户端）。 */
export function parseHeartBeat(payload: Buffer): bigint {
  return new ByteReader(payload).readLong();
}

export function parseHeartBeatResponse(payload: Buffer): { echo: bigint; fps: number | null } {
  const r = new ByteReader(payload);
  const echo = r.readLong();
  const version = r.readUnsignedByte();
  let fps: number | null = null;
  if (version >= 1) fps = r.readUnsignedByte();
  return { echo, fps };
}

/** 112 CLIENT_STATUS：报告"已加载、不阻塞"。 */
export function buildClientStatus(loaded = true): Buffer {
  const w = new ByteWriter();
  w.writeBoolean(!loaded); // bG：未加载标志
  w.writeBoolean(!loaded); // isLoading
  return w.toBuffer();
}

/**
 * 开局(120)后的"已进入对局"应答。真客户端实测载荷 = 00 01（2026-09-11 代理抓包）：
 * 第二字节必须为 01，发 00 00 服务器不认，会持续 "Still waiting on" 点名。
 */
export function buildGameStartedStatus(): Buffer {
  return Buffer.from([0x00, 0x01]);
}

/** 117 密码请求（服务器→客户端）。 */
export function parsePasswordRequest(payload: Buffer): { requestId: number; prompt: string } {
  const r = new ByteReader(payload);
  r.readByte();
  const requestId = r.readInt();
  const prompt = r.readUTF();
  return { requestId, prompt };
}

/** 118 密码应答（客户端→服务器）。 */
export function buildPasswordResponse(requestId: number, password: string): Buffer {
  const w = new ByteWriter();
  w.writeByte(1);
  w.writeInt(requestId);
  w.writeUTF(password);
  return w.toBuffer();
}

/** 150/111 原因文本。 */
export function parseReasonText(payload: Buffer): string {
  try {
    return new ByteReader(payload).readUTF();
  } catch {
    return "";
  }
}

/** 111 断开通知（客户端→服务器，礼貌退出）。 */
export function buildDisconnect(reason: string): Buffer {
  return new ByteWriter().writeUTF(reason).toBuffer();
}
