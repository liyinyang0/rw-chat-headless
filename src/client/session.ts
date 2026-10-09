import { EventEmitter } from "node:events";
import { RwConnection, type SocksProxyTarget } from "./connection.ts";
import type { ConnectTarget } from "../masterserver/target.ts";
import {
  PacketType,
  buildChat,
  buildClientStatus,
  buildDisconnect,
  buildGameStartedStatus,
  buildHeartBeat,
  buildHeartBeatResponse,
  buildHello,
  buildPasswordResponse,
  buildRegister,
  parseChatReceive,
  parseHeartBeat,
  parseHeartBeatResponse,
  parsePasswordRequest,
  parsePreregisterInfo,
  parseReasonText,
  type ChatMessageReceived,
  type PreregisterInfo,
} from "../protocol/packets/common.ts";
import { parsePowChallenge, buildPowResponse, solvePowChallenge } from "../protocol/packets/pow.ts";
import { parseServerInfo, parseTeamList, type RoomSettingsLite, type ServerInfoLite, type TeamEntry } from "../protocol/packets/room.ts";
import { integrityString } from "../protocol/integrity.ts";

export type SessionState =
  | "idle"
  | "connecting"
  | "awaiting-preregister"
  | "awaiting-register"
  | "battleroom"
  | "kicked"
  | "disconnected";

export type GamePhase = "lobby" | "in_game";

export interface SessionEvents {
  chat: ChatMessageReceived;
  stateChange: SessionState;
  rosterChange: TeamEntry[];
  roomInfo: ServerInfoLite;
  phaseChange: GamePhase;
  gameEnded: undefined;
  kicked: string;
  disconnected: string;
  log: string;
}

export interface SessionOptions {
  playerName: string;
  password?: string | null;
  language?: string;
  /** 注册格式版本：5=完整指纹（v176 系要求）；2=老客户端精简格式。 */
  formatVersion?: 2 | 5;
  /** 核心单位校验和（真 RWX 服务器会校验；Rukkit/RW-HPS 不校验）。 */
  unitsChecksum?: number;
  /** 官方中继的房间 id（117 提问时的应答；null 则回当前 query）。 */
  relayRoomId?: string | null;
  /** 固定客户端 UUID 种子；每次中继跳转后结合当前 serverUuid 派生最终 ID。 */
  clientUuid?: string;
  /** 可选 SOCKS5 出口；中继重定向后的每一跳都会继续使用。 */
  socksProxy?: SocksProxyTarget;
  /** 房主开局时的策略：stay（默认）=留在房间并回 112 报已加载；leave=开局即断开。 */
  onGameStart?: "stay" | "leave";
  heartbeatMs?: number;
  /** 打印每个收到的帧类型（调试用）。 */
  debugFrames?: boolean;
}

declare interface Session {
  on<K extends keyof SessionEvents>(event: K, listener: (payload: SessionEvents[K]) => void): this;
  emit<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): boolean;
}

/** 中继会通过 117 提示明确告知房间不存在；此时重发房间码只会形成无效循环。 */
export function isRoomUnavailablePrompt(prompt: string): boolean {
  return /(?:房间\s*ID.*(?:不存在|已关闭)|找不到这个服务器|房间号.*不存在|game\s+not\s+found)/i.test(prompt);
}

export interface RelayRedirectAddress {
  host: string;
  port: number;
  /** 地址路径内嵌的第二跳房间码（CNKD 系中继形态 host/room:port）；无则为 null。 */
  room: string | null;
}

/**
 * 解析 178 跳转载荷中的目标地址。载荷形态：
 *   "[TCP]host:port"      — 官方 relay / 普通跳转
 *   "[TCP]host/room:port" — CNKD 系中继：第二跳房间码内嵌在路径里，
 *                            117 应答须改用该房间码（入口的 r 前缀码到节点已失效）。
 * 匹配不到地址返回 null。
 */
export function parseRelayRedirect(text: string): RelayRedirectAddress | null {
  const m = text.match(/\[TCP\]([^\s\x00]+)/) ?? text.match(/([0-9a-zA-Z.\-]+:\d+)/);
  if (!m) return null;
  const addr = m[1]!;
  const slashIdx = addr.indexOf("/");
  const hostPart = slashIdx >= 0 ? addr.slice(0, slashIdx) : addr;
  const roomPart = slashIdx >= 0 ? addr.slice(slashIdx + 1) : null;
  const [hostRaw, portFromHost] = hostPart.split(":");
  const host = hostRaw!;
  let port = Number(portFromHost);
  let room: string | null = null;
  if (roomPart) {
    const [roomRaw, portFromRoom] = roomPart.split(":");
    room = roomRaw!;
    const p = Number(portFromRoom);
    if (Number.isFinite(p) && p > 0) port = p;
  }
  if (!Number.isFinite(port) || port <= 0) port = 5123;
  return { host, port, room };
}

/**
 * 无头客户端会话状态机：
 * connect → 160 → (161) → 110 → [113 密码重试] → 115/106 → 战役室（聊天/keepalive）。
 */
class Session extends EventEmitter {
  state: SessionState = "idle";
  info: PreregisterInfo | null = null;
  roomInfo: ServerInfoLite | null = null;
  roster: TeamEntry[] = [];
  yourTeamId = -1;
  settings: RoomSettingsLite = {};
  phase: GamePhase = "lobby";
  /** 最近一次客户端心跳 RTT；不可用时为 null。 */
  pingMs: number | null = null;
  /** 最近一次 115 携带的槽位数；未经抓包验证不等同人数上限。 */
  slotCount: number | null = null;

  private conn: RwConnection | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPingSentAt = 0;
  private lastPongAt = 0;
  private joinedOnce = false;
  private registerSentAtLeastOnce = false;
  /** 117 去重（同提示只答一次）。 */
  private last117Key = "";
  /** 跳转后保留的房间码（117 应答用）。 */
  private pendingRelayRoomId: string | null = null;
  /** 中继跳转次数上限（防环）。 */
  private redirects = 0;
  private redirecting = false;
  private disconnectedNotified = false;

  constructor(
    private target: ConnectTarget,
    private opts: SessionOptions,
  ) {
    super();
  }

  private log(msg: string) {
    this.emit("log", `[${this.target.label}] ${msg}`);
  }

  private setState(s: SessionState) {
    this.state = s;
    this.emit("stateChange", s);
  }

  async start(): Promise<void> {
    this.disconnectedNotified = false;
    this.setState("connecting");
    const conn = new RwConnection({
      host: this.target.host,
      port: this.target.port,
      socksProxy: this.opts.socksProxy,
    });
    this.conn = conn;
    conn.on("frame", (frame) => this.handleFrame(frame));
    conn.on("close", (reason) => {
      this.stopHeartbeat();
      if (this.redirecting) return; // 跳转流程中，不视为断线
      if (this.state !== "kicked") this.notifyDisconnected(reason);
    });
    await conn.connect();
    this.log(`connected, sending hello`);
    this.setState("awaiting-preregister");
    conn.send(
      PacketType.PREREGISTER_REQUEST,
      buildHello({
        playerName: this.opts.playerName,
        language: this.opts.language ?? "en",
        queryString: this.target.queryString ?? null,
      }),
    );
  }

  /**
   * 178 中继跳转：载荷含 "[TCP]host:port" 或 "[TCP]host/room:port"
   * （CNKD 系路径内嵌第二跳房间码）。断开并重连真实服务器
   * （query 不再携带——路由已由第一跳完成）。
   */
  private onRedirect(payload: Buffer) {
    if (this.redirects >= 3) {
      this.log(`redirect limit reached, ignoring`);
      return;
    }
    const text = payload.toString("latin1");
    const addr = parseRelayRedirect(text);
    if (!addr) {
      this.log(`got 178 but no address found: ${JSON.stringify(text.slice(0, 60))}`);
      return;
    }
    const { host, port, room } = addr;
    this.redirects++;
    this.redirecting = true;
    this.log(`relay redirect #${this.redirects} → ${host}${room ? "/" + room : ""}:${port}`);
    this.joinedOnce = false;
    this.registerSentAtLeastOnce = false;
    this.conn?.close("redirecting");
    // CNKD 系节点用 hello 的 query string 做房间路由（实测：不带 query 会被
    // 分配到自动托管空房，而非码对应的真房）。178 内嵌的 room 即第二跳路由键。
    // 兜底：若节点改为 117 提问，pendingRelayRoomId 也能答上。
    if (room) {
      this.pendingRelayRoomId = room;
    } else if (this.target.queryString) {
      this.pendingRelayRoomId = this.target.queryString;
    }
    this.target = {
      host,
      port,
      queryString: room ?? undefined,
      gameId: this.target.gameId,
      label: `${host}${room ? "/" + room : ""}:${port} (redirected)`,
    };
    this.redirecting = false;
    void this.start().catch((err) => {
      this.log(`redirect connect failed: ${err instanceof Error ? err.message : err}`);
      this.notifyDisconnected(String(err));
    });
  }

  private handleFrame(frame: { type: number; payload: Buffer }) {
    if (this.opts.debugFrames) {
      this.log(`frame <- type=${frame.type} len=${frame.payload.length}`);
    }
    switch (frame.type) {
      case PacketType.PREREGISTER_INFO:
        return this.onPreregisterInfo(frame.payload);
      case PacketType.PASSWORD_ERROR:
        return this.onPasswordError();
      case PacketType.RELAY_117:
        return this.onRelayPasswordRequest(frame.payload);
      case PacketType.REGISTER_PLAYER:
        return; // 服务器不会给客户端发 110
      case PacketType.TEAM_LIST:
        return this.onTeamList(frame.payload);
      case PacketType.SERVER_COMMAND:
        return; // 4：调试包
      case PacketType.CHAT_RECEIVE:
        return this.onChatReceive(frame.payload);
      case PacketType.HEART_BEAT:
        return this.onHeartBeat(frame.payload);
      case PacketType.HEART_BEAT_RESPONSE:
        return this.onHeartBeatResponse(frame.payload);
      case PacketType.KICK:
        return this.onKick(frame.payload);
      case PacketType.DISCONNECT:
        return this.onRemoteDisconnect(frame.payload);
      case PacketType.RELAY_POW:
        return this.onPow(frame.payload);
      case PacketType.RELAY_REDIRECT: // 178：RW-HPS 中继要求重连真实服务器
        return this.onRedirect(frame.payload);
      default:
        // 106 等剩余握手/系统包
        if (frame.type === 106) return this.onServerInfo(frame.payload);
        // 120 开局 / 122 回房：回 112 报"已加载"，否则服务器会 "Still waiting on" 卡全房
        if (frame.type === 120) return this.onGameStart();
        if (frame.type === 122) return this.onReturnToLobby();
        // 30 帧数据等其余游戏包：无头客户端忽略
        return;
    }
  }

  private onPreregisterInfo(payload: Buffer) {
    try {
      this.info = parsePreregisterInfo(payload);
    } catch (err) {
      this.log(`bad 161: ${err instanceof Error ? err.message : err}`);
      this.conn?.close("bad 161");
      return;
    }
    const netVer = this.info.networkVersion;
    this.log(
      `got 161: serverVersion=${netVer} uuid=${this.info.serverUuid.slice(0, 8)}… ` +
        `seed=${this.info.sessionRandomId} salt=${this.info.integritySalt}`,
    );
    if (this.opts.debugFrames && this.info.sessionRandomId !== null) {
      this.log(`g(${this.info.sessionRandomId}) = ${integrityString(this.info.sessionRandomId)}`);
    }
    this.sendRegister();
  }

  private sendRegister() {
    if (!this.info) return;
    this.setState("awaiting-register");
    this.conn?.send(
      PacketType.REGISTER_PLAYER,
      buildRegister({
        playerName: this.opts.playerName,
        networkVersion: this.info.networkVersion,
        password: this.opts.password ?? null,
        formatVersion: this.opts.formatVersion ?? 5,
        unitsChecksum: this.opts.unitsChecksum ?? 0,
        serverUuid: this.info.serverUuid,
        clientUuid: this.opts.clientUuid,
        sessionRandomId: this.info.sessionRandomId,
        integritySalt: this.info.integritySalt,
      }),
    );
    this.log(`sent 110 register (format=${this.opts.formatVersion ?? 5})`);
    this.registerSentAtLeastOnce = true;
  }

  /** 113：房间需要密码/密码错误 → 带哈希重发 110。 */
  private onPasswordError() {
    if (this.opts.password) {
      this.log(`got 113 (wrong password?)`);
      this.emit("kicked", "Wrong password");
      this.setState("kicked");
      this.conn?.close("wrong password");
    } else {
      this.log(`got 113: server requires password but none configured`);
      this.emit("kicked", "Password required");
      this.setState("kicked");
      this.conn?.close("password required");
    }
  }

  /**
   * 117：中继房间选择/密码请求。语义（官方中继与 RELAY-CN 集群一致）：
   * 应答 = 房间码（进房）/"new"（建房）/房间密码。
   * 默认回当前连接的房间码（queryString），可用 RELAY_ROOM_ID 覆盖。
   */
  private onRelayPasswordRequest(payload: Buffer) {
    let requestId = 0;
    let prompt = "";
    try {
      const req = parsePasswordRequest(payload);
      requestId = req.requestId;
      prompt = req.prompt;
    } catch {
      /* ignore */
    }
    // 每轮都应答（节点可能多轮提问：先警告后问房码）；同一提示只打一次日志
    const key = `${requestId}:${prompt}`;
    if (this.last117Key !== key) {
      this.last117Key = key;
      this.log(`got 117 request (id=${requestId}): "${prompt.replace(/\n/g, " ").slice(0, 80)}"`);
    }
    if (isRoomUnavailablePrompt(prompt)) {
      this.setState("kicked");
      this.emit("kicked", "room not found");
      this.conn?.close("room not found");
      return;
    }
    const answer = this.opts.relayRoomId ?? this.pendingRelayRoomId ?? this.target.queryString ?? "";
    this.conn?.send(PacketType.RELAY_118, buildPasswordResponse(requestId, answer));
  }

  private onTeamList(payload: Buffer) {
    const sv = this.info?.networkVersion ?? 999999;
    try {
      const result = parseTeamList(payload, sv);
      this.roster = result.delta ? mergeRosterDelta(this.roster, result.teams) : result.teams;
      this.yourTeamId = result.yourTeamId;
      this.settings = { ...this.settings, ...result.settings };
      this.slotCount = result.slotCount;
      if (!this.joinedOnce) {
        this.joinedOnce = true;
        this.setState("battleroom");
        this.log(`in battleroom: ${this.roster.filter((t) => !t.isAi && t.connectionActive).length} active players`);
        // 报告已加载，避免阻塞房主开局
        this.conn?.send(PacketType.CLIENT_STATUS, buildClientStatus(true));
        this.startHeartbeat();
      }
      this.emit("rosterChange", this.roster);
    } catch (err) {
      this.log(`team list parse failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  private onServerInfo(payload: Buffer) {
    try {
      this.roomInfo = parseServerInfo(payload);
      this.emit("roomInfo", this.roomInfo);
      this.log(
        `room info: map=${this.roomInfo.mapPath ?? "?"} mods=${this.roomInfo.hasCustomUnits ? "yes(skipped)" : "no"}`,
      );
    } catch (err) {
      this.log(`server info parse failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 120 开局：默认回 112 报"已加载"不阻塞全房；onGameStart=leave 时开局即退出。 */
  private onGameStart() {
    if (this.opts.onGameStart === "leave") {
      this.log(`game start (type=120) → onGameStart=leave，主动退出`);
      this.disconnect("game start (packet 120)");
      return;
    }
    this.phase = "in_game";
    this.emit("phaseChange", this.phase);
    this.conn?.send(PacketType.CLIENT_STATUS, buildGameStartedStatus());
    this.log(`game start (type=120) → 已回 112(00 01) 报进入对局（不阻塞开局）`);
  }

  /** 122：对局结束回到战役室。保留原兼容应答，同时给上层独立的生命周期事件。 */
  private onReturnToLobby() {
    const ended = this.phase === "in_game";
    this.phase = "lobby";
    this.emit("phaseChange", this.phase);
    this.conn?.send(PacketType.CLIENT_STATUS, buildGameStartedStatus());
    this.log(`return to lobby (type=122) → 已回 112(00 01)`);
    if (ended) this.emit("gameEnded", undefined);
  }

  private onChatReceive(payload: Buffer) {
    try {
      const chat = parseChatReceive(payload);
      this.emit("chat", chat);
      // 服务器点名"还在等你加载"时再回一次 112：点名即触发，
      // 规避开局包刚到时应答过早（早于服务器进入等待态）被忽略的时机问题
      if (
        !chat.senderName &&
        /still waiting on/i.test(chat.message) &&
        chat.message.includes(this.opts.playerName)
      ) {
        this.conn?.send(PacketType.CLIENT_STATUS, buildGameStartedStatus());
        this.log(`被点名等待加载 → 已再回 112(00 01)`);
      }
    } catch (err) {
      this.log(`chat parse failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  private onHeartBeat(payload: Buffer) {
    // 服务器也可能 ping 客户端：回 109
    try {
      const ts = parseHeartBeat(payload);
      this.conn?.send(PacketType.HEART_BEAT_RESPONSE, buildHeartBeatResponse(ts));
    } catch {
      /* ignore */
    }
  }

  private onHeartBeatResponse(payload: Buffer) {
    try {
      const { echo } = parseHeartBeatResponse(payload);
      this.lastPongAt = Date.now();
      const rtt = Date.now() - Number(echo);
      if (rtt > 0 && rtt < 10_000) {
        this.pingMs = rtt;
        this.log(`ping ${rtt}ms`);
      }
    } catch {
      /* ignore */
    }
  }

  private onKick(payload: Buffer) {
    const reason = parseReasonText(payload);
    this.log(`kicked: ${reason}`);
    this.setState("kicked");
    this.emit("kicked", reason);
    this.stopHeartbeat();
    this.conn?.close(`kicked: ${reason}`);
  }

  private onRemoteDisconnect(payload: Buffer) {
    const reason = parseReasonText(payload);
    this.log(`server disconnected: ${reason || "(no reason)"}`);
    this.stopHeartbeat();
    this.notifyDisconnected(reason);
    this.conn?.close("remote disconnect");
  }

  private onPow(payload: Buffer) {
    const start = Date.now();
    try {
      const challenge = parsePowChallenge(payload);
      this.log(`pow challenge type=${challenge.type} id=${challenge.id}`);
      const answer = solvePowChallenge(challenge);
      const elapsed = (Date.now() - start) / 1000;
      this.conn?.send(
        PacketType.RELAY_POW_RECEIVE,
        buildPowResponse(challenge.id, challenge.type, answer, elapsed),
      );
      // 严格模仿真实客户端：PoW 后不重发 110（RELAY-CN 节点会拒绝重发行为的连接）。
      // 官方老中继如需重发可设 POW_REREGISTER=1。
      if (
        this.state === "awaiting-register" &&
        this.registerSentAtLeastOnce &&
        (process.env.POW_REREGISTER === "1" || process.env.POW_REREGISTER === "true")
      ) {
        this.log(`pow answered, re-sending register`);
        this.sendRegister();
      }
    } catch (err) {
      this.log(`pow solve failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private startHeartbeat() {
    const interval = this.opts.heartbeatMs ?? 2000;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.conn || this.conn.isClosed) return;
      // 服务器 accept 时 setSoTimeout(15s)：必须周期性发包保活
      this.lastPingSentAt = Date.now();
      this.conn.send(PacketType.HEART_BEAT, buildHeartBeat());
    }, interval);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendChat(message: string): boolean {
    if (this.state !== "battleroom") {
      this.log(`cannot send chat in state ${this.state}`);
      return false;
    }
    if (!this.conn || this.conn.isClosed) return false;
    this.conn.send(PacketType.CHAT, buildChat(message));
    return true;
  }

  disconnect(reason = "headless client leaving"): void {
    this.stopHeartbeat();
    try {
      this.conn?.send(PacketType.DISCONNECT, buildDisconnect(reason));
    } catch {
      /* ignore */
    }
    this.notifyDisconnected(reason);
    this.conn?.close(reason);
  }

  private notifyDisconnected(reason: string): void {
    if (this.disconnectedNotified) return;
    this.disconnectedNotified = true;
    this.setState("disconnected");
    this.emit("disconnected", reason);
  }
}

export { Session };

/** 精简 115 只覆盖网络状态；名字、阵营、观战和房主原始标志沿用完整名单。 */
export function mergeRosterDelta(current: TeamEntry[], delta: TeamEntry[]): TeamEntry[] {
  const bySlot = new Map(current.map((entry) => [entry.slotId, entry]));
  for (const update of delta) {
    const previous = bySlot.get(update.slotId);
    bySlot.set(update.slotId, previous ? {
      ...previous,
      connectionActive: update.connectionActive,
      isAi: update.isAi,
    } : update);
  }
  return [...bySlot.values()].sort((a, b) => a.slotId - b.slotId);
}

function envRedirectDropQuery(): boolean {
  return process.env.REDIRECT_DROP_QUERY === "1" || process.env.REDIRECT_DROP_QUERY === "true";
}
