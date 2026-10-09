import { EventEmitter } from "node:events";
import { RwConnection, type SocksProxyTarget } from "./connection.ts";
import { parseConnectTarget, resolveTarget, type ConnectTarget } from "../masterserver/target.ts";
import { ByteReader, ProtocolError } from "../protocol/primitives.ts";
import {
  PacketType,
  VERSION_CODE,
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
import { parsePowChallenge, buildPowResponse, solvePowChallenge, createPowState } from "../protocol/packets/pow.ts";
import { parseGameStart, parseServerInfo, parseTeamList, type GameStartInfo, type RoomSettingsLite, type ServerInfoLite, type TeamEntry } from "../protocol/packets/room.ts";
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
  settingsChange: RoomSettingsLite;
  gameStart: GameStartInfo;
  phaseChange: GamePhase;
  gameEnded: undefined;
  kicked: string;
  disconnected: string;
  log: string;
  inputRequest: SessionInputRequest;
}

export interface SessionInputRequest {
  kind: "prompt" | "password";
  requestId: number | null;
  prompt: string;
  target: Readonly<ConnectTarget>;
  /** null 取消连接；应答只对当前连接和当前请求有效。 */
  respond(answer: string | null): void;
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
  maxRedirects?: number;
  inputTimeoutMs?: number;
  /** 未返回字符串时保留请求，调用方可稍后通过 respond 应答。 */
  onInputRequest?: (request: SessionInputRequest) => string | null | undefined | Promise<string | null | undefined>;
}

declare interface Session {
  on<K extends keyof SessionEvents>(event: K, listener: (payload: SessionEvents[K]) => void): this;
  emit<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): boolean;
}

/** 中继会通过 117 提示明确告知房间不存在；此时重发房间码只会形成无效循环。 */
export function isRoomUnavailablePrompt(prompt: string): boolean {
  return /(?:房间\s*ID.*(?:不存在|已关闭)|找不到这个服务器|房间号.*不存在|game\s+not\s+found)/i.test(prompt);
}

export interface RelayRedirect {
  formatVersion: number;
  reconnectId: number;
  showFailure: boolean;
  addresses: string[];
}

/**
 * 原版 178：byte + int + boolean + int count + Java UTF 连接字符串列表。
 * showFailure 控制原版的失败提示，不是 TCP/UDP 标志；地址交回通用解析器。
 */
export function parseRelayRedirect(payload: Buffer): RelayRedirect {
  const r = new ByteReader(payload);
  const formatVersion = r.readUnsignedByte();
  const reconnectId = r.readInt();
  const showFailure = r.readBoolean();
  const count = r.readInt();
  if (count < 0 || count > 256 || count > Math.floor(r.remaining / 2)) throw new ProtocolError("invalid reconnect address count");
  const addresses = Array.from({ length: count }, () => r.readUTF());
  return { formatVersion, reconnectId, showFailure, addresses };
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
  gameStartInfo: GameStartInfo | null = null;
  serverEnded = false;
  private gameEndedNotified = false;
  /** 最近一次客户端心跳 RTT；不可用时为 null。 */
  pingMs: number | null = null;
  /** 最近一次 115 携带的槽位数；未经抓包验证不等同人数上限。 */
  slotCount: number | null = null;

  private conn: RwConnection | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPingSentAt = 0;
  private lastPongAt = 0;
  private joinedOnce = false;
  /** 117 去重（同提示只答一次）。 */
  private last117Key = "";
  /** 跳转后保留的房间码（117 应答用）。 */
  private pendingRelayRoomId: string | null = null;
  /** 中继跳转次数上限（防环）。 */
  private redirects = 0;
  private redirecting = false;
  private disconnectedNotified = false;
  private connectionGeneration = 0;
  private readonly powState = createPowState();
  private password: string | null;
  private pendingInput: { request: SessionInputRequest; timer: NodeJS.Timeout } | null = null;

  constructor(
    private target: ConnectTarget,
    private opts: SessionOptions,
  ) {
    super();
    this.password = opts.password ?? null;
  }

  get pendingInputRequest(): SessionInputRequest | null {
    return this.pendingInput?.request ?? null;
  }

  private log(msg: string) {
    this.emit("log", `[${this.target.label}] ${msg}`);
  }

  private setState(s: SessionState) {
    this.state = s;
    this.emit("stateChange", s);
  }

  async start(): Promise<void> {
    this.redirects = 0;
    this.pendingRelayRoomId = null;
    await this.openConnection();
  }

  private async openConnection(): Promise<void> {
    const generation = ++this.connectionGeneration;
    const previous = this.conn;
    this.conn = null;
    previous?.close("replaced connection");
    this.stopHeartbeat();
    this.clearInputRequest();
    this.joinedOnce = false;
    this.info = null;
    this.roomInfo = null;
    this.roster = [];
    this.yourTeamId = -1;
    this.settings = {};
    this.slotCount = null;
    this.phase = "lobby";
    this.gameStartInfo = null;
    this.serverEnded = false;
    this.gameEndedNotified = false;
    this.pingMs = null;
    this.last117Key = "";
    this.redirecting = false;
    this.disconnectedNotified = false;
    this.setState("connecting");
    const conn = new RwConnection({
      host: this.target.host,
      port: this.target.port,
      socksProxy: this.opts.socksProxy,
    });
    this.conn = conn;
    const isCurrent = () => this.conn === conn && generation === this.connectionGeneration;
    conn.on("frame", (frame) => { if (isCurrent()) this.handleFrame(frame); });
    conn.on("close", (reason) => {
      if (!isCurrent()) return;
      this.stopHeartbeat();
      this.clearInputRequest();
      if (this.redirecting) return; // 跳转流程中，不视为断线
      if (this.state !== "kicked") this.notifyDisconnected(reason);
    });
    try {
      await conn.connect();
    } catch (error) {
      if (isCurrent()) this.disconnect(error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (!isCurrent()) { conn.close("cancelled connection"); return; }
    this.log(`connected, sending hello`);
    this.setState("awaiting-preregister");
    conn.send(
      PacketType.PREREGISTER_REQUEST,
      buildHello({
        playerName: this.opts.playerName,
        language: this.opts.language ?? "en",
        queryString: this.target.queryString ?? null,
        networkVersion: VERSION_CODE,
      }),
    );
  }

  /** 和原版一样，使用列表首个连接字符串并复用同一目标语法。 */
  private async onRedirect(payload: Buffer): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      if (this.redirects >= (this.opts.maxRedirects ?? 3)) throw new Error("redirect limit reached");
      const redirect = parseRelayRedirect(payload);
      const address = redirect.addresses[0];
      if (!address) throw new Error("reconnect packet has no target");
      const parsed = parseConnectTarget(address);
      this.redirects++;
      this.redirecting = true;
      this.stopHeartbeat();
      this.clearInputRequest();
      const previous = this.conn;
      this.conn = null;
      previous?.close("redirecting");
      this.setState("connecting");
      const next = await resolveTarget(parsed, this.password);
      if (generation !== this.connectionGeneration) return;
      this.pendingRelayRoomId = next.queryString ?? this.target.queryString ?? this.pendingRelayRoomId;
      this.target = next;
      this.log(`relay redirect #${this.redirects}`);
      this.redirecting = false;
      await this.openConnection();
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this.redirecting = false;
      this.disconnect(`reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleFrame(frame: { type: number; payload: Buffer }) {
    if (this.redirecting) return;
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
      case 116:
        return this.onServerGameEnd(frame.payload);
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
      case PacketType.RELAY_REDIRECT:
        return void this.onRedirect(frame.payload);
      default:
        // 106 等剩余握手/系统包
        if (frame.type === 106) return this.onServerInfo(frame.payload);
        // 120 开局 / 122 回房：回 112 报"已加载"，否则服务器会 "Still waiting on" 卡全房
        if (frame.type === 120) return this.onGameStart(frame.payload);
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
        networkVersion: VERSION_CODE,
        password: this.password,
        formatVersion: this.opts.formatVersion ?? 5,
        unitsChecksum: this.opts.unitsChecksum,
        serverUuid: this.info.serverUuid,
        clientUuid: this.opts.clientUuid,
        sessionRandomId: this.info.sessionRandomId,
        integritySalt: this.info.integritySalt,
      }),
    );
    this.log(`sent 110 register (format=${this.opts.formatVersion ?? 5})`);
  }

  /** 113：房间需要密码/密码错误 → 带哈希重发 110。 */
  private onPasswordError() {
    this.requestInput("password", null, this.password == null ? "Password required" : "Wrong password; enter another password");
  }

  /** 117 是任意输入请求；明确的房间号/密码提示自动应答，其余交给调用方。 */
  private onRelayPasswordRequest(payload: Buffer) {
    let requestId = 0;
    let prompt = "";
    try {
      const req = parsePasswordRequest(payload);
      requestId = req.requestId;
      prompt = req.prompt;
    } catch {
      this.disconnect("invalid input request packet");
      return;
    }
    // 原版提示是任意输入；重复提示仅去重日志，不猜测未知请求的应答。
    const key = `${requestId}:${prompt}`;
    if (this.last117Key !== key) {
      this.last117Key = key;
      this.log(`got 117 request (id=${requestId}): "${prompt.replace(/\n/g, " ").slice(0, 80)}"`);
    }
    if (isRoomUnavailablePrompt(prompt)) {
      this.setState("kicked");
      this.emit("kicked", "room not found");
      this.clearInputRequest();
      this.stopHeartbeat();
      this.conn?.close("room not found");
      return;
    }
    this.requestInput("prompt", requestId, prompt);
  }

  private requestInput(kind: SessionInputRequest["kind"], requestId: number | null, prompt: string): void {
    this.clearInputRequest();
    const connection = this.conn;
    const generation = this.connectionGeneration;
    const request: SessionInputRequest = {
      kind, requestId, prompt, target: { ...this.target },
      respond: (answer) => {
        if (this.pendingInput?.request !== request || this.conn !== connection || generation !== this.connectionGeneration) return;
        this.clearInputRequest();
        if (answer === null) { this.disconnect("input cancelled"); return; }
        try {
          if (kind === "password") { this.password = answer; this.sendRegister(); }
          else connection?.send(PacketType.RELAY_118, buildPasswordResponse(requestId!, answer));
        } catch {
          this.disconnect("could not encode input response");
        }
      },
    };
    const timer = setTimeout(() => {
      if (this.pendingInput?.request === request) this.disconnect("input timeout");
    }, this.opts.inputTimeoutMs ?? 60_000);
    timer.unref();
    this.pendingInput = { request, timer };
    if (this.opts.onInputRequest) {
      this.emit("inputRequest", request);
      try {
        void Promise.resolve(this.opts.onInputRequest(request)).then((answer) => {
          if (answer !== undefined) request.respond(answer);
        }).catch(() => {
          if (this.pendingInput?.request === request) this.disconnect("input handler failed");
        });
      } catch {
        if (this.pendingInput?.request === request) this.disconnect("input handler failed");
      }
      return;
    }
    if (kind === "prompt") {
      if (/password|密码|口令/i.test(prompt)) {
        if (this.password !== null) { request.respond(this.password); return; }
      } else if (/\b(?:room|game)[\s_-]*(?:id|code|number)\b|\benter\s+(?:a\s+|the\s+)?room\b|房间(?:号|\s*id)|房號|房号/i.test(prompt)) {
        const room = this.opts.relayRoomId ?? this.target.queryString ?? this.pendingRelayRoomId;
        if (room != null) { request.respond(room); return; }
      }
    }
    this.emit("inputRequest", request);
  }

  private clearInputRequest(): void {
    if (this.pendingInput) clearTimeout(this.pendingInput.timer);
    this.pendingInput = null;
  }

  private onTeamList(payload: Buffer) {
    const sv = this.info?.networkVersion ?? 999999;
    try {
      const result = parseTeamList(payload, sv);
      this.roster = result.delta ? mergeRosterDelta(this.roster, result.teams) : result.teams;
      this.yourTeamId = result.yourTeamId;
      this.settings = { ...this.settings, ...result.settings };
      this.slotCount = result.slotCount;
      if (result.delta && this.phase !== "in_game") {
        this.phase = "in_game";
        this.gameEndedNotified = false;
        this.serverEnded = false;
        this.emit("phaseChange", this.phase);
      }
      if (!this.joinedOnce) {
        this.joinedOnce = true;
        this.setState("battleroom");
        this.log(`in battleroom: ${this.roster.filter((t) => !t.isAi && t.connectionActive).length} active players`);
        // 报告已加载，避免阻塞房主开局
        this.conn?.send(PacketType.CLIENT_STATUS, buildClientStatus(true));
        this.startHeartbeat();
      }
      this.emit("rosterChange", this.roster);
      this.emit("settingsChange", { ...this.settings });
    } catch (err) {
      this.log(`team list parse failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  private onServerInfo(payload: Buffer) {
    try {
      this.roomInfo = parseServerInfo(payload);
      const settings: RoomSettingsLite = { ...this.settings };
      for (const key of ["fogMode", "startingCredits", "revealedMap", "aiDifficulty", "currentUnitCap", "maxUnitCap", "startingUnits", "incomeMultiplier", "noNukes", "sharedControl"] as const) {
        const value = this.roomInfo[key];
        if (value != null) Object.assign(settings, { [key]: value });
      }
      this.settings = settings;
      this.emit("settingsChange", { ...settings });
      this.emit("roomInfo", this.roomInfo);
      this.log(
        `room info: map=${this.roomInfo.mapPath ?? "?"} mods=${this.roomInfo.hasCustomUnits ? "yes(skipped)" : "no"}`,
      );
    } catch (err) {
      this.log(`server info parse failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 120 开局：默认回 112 报"已加载"不阻塞全房；onGameStart=leave 时开局即退出。 */
  private onGameStart(payload?: Buffer) {
    if (payload !== undefined) {
      try {
        this.gameStartInfo = parseGameStart(payload);
      } catch {
        this.disconnect("invalid game start packet");
        return;
      }
    }
    if (this.opts.onGameStart === "leave") {
      this.log(`game start (type=120) → onGameStart=leave，主动退出`);
      this.disconnect("game start (packet 120)");
      return;
    }
    this.phase = "in_game";
    this.serverEnded = false;
    this.gameEndedNotified = false;
    if (this.gameStartInfo) this.emit("gameStart", this.gameStartInfo);
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
    if (ended) this.notifyGameEnded();
  }

  private onServerGameEnd(payload: Buffer): void {
    try {
      const r = new ByteReader(payload);
      r.readInt();
      if (r.readBoolean()) { this.serverEnded = true; this.notifyGameEnded(); }
    } catch { this.disconnect("invalid game end packet"); }
  }

  private notifyGameEnded(): void {
    if (this.gameEndedNotified) return;
    this.gameEndedNotified = true;
    this.emit("gameEnded", undefined);
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
    this.clearInputRequest();
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
      const challenge = parsePowChallenge(payload, this.powState);
      this.log(`pow challenge type=${challenge.type} id=${challenge.id}`);
      const answer = solvePowChallenge(challenge);
      const elapsed = (Date.now() - start) / 1000;
      this.conn?.send(
        PacketType.RELAY_POW_RECEIVE,
        buildPowResponse(challenge.id, challenge.type, answer, elapsed),
      );
    } catch (err) {
      this.disconnect(`pow solve failed: ${err instanceof Error ? err.message : err}`);
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
    this.connectionGeneration++;
    this.clearInputRequest();
    this.stopHeartbeat();
    this.disconnectedNotified = true;
    this.setState("disconnected");
    this.emit("disconnected", reason);
  }
}
export { Session };

/** 精简 115 仍提供全部槽位存在性；只继承本包存在玩家的未传字段。 */
export function mergeRosterDelta(current: TeamEntry[], delta: TeamEntry[]): TeamEntry[] {
  const bySlot = new Map(current.map((entry) => [entry.slotId, entry]));
  return delta.map((update) => {
    const previous = bySlot.get(update.slotId);
    return previous ? {
      ...previous,
      connectionActive: update.connectionActive,
      pingMs: update.pingMs,
      isAi: update.isAi,
      sharedControlManual: update.sharedControlManual,
      sharedControlAutomatic: update.sharedControlAutomatic,
    } : update;
  }).sort((a, b) => a.slotId - b.slotId);
}
