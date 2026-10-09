/**
 * 单进程多房间 runner。
 *
 * 协议约束：一条 TCP 连接同一时刻只能在一个战役室（进房绑定在连接上），
 * 多房间 = 多条连接。本 runner 把 N 个 Session 装进同一进程：
 *  - 统一展开/解析目标（list:N 只拉一次房间列表）
 *  - 每会话分配唯一 clientId：缺省派生算法用 serverUuid 派生，同一服务器上
 *    的多个房间会撞，必须显式区分（后缀 -m1/-m2/…）
 *  - 默认玩家名加槽位后缀（name、name-2…），防同服务器重名互踢
 *  - 错峰启动；单房失败不影响其余
 *  - 每房保留最近 200 条聊天（handle.history()）
 */
import { listRooms, roomConnectDescriptor, type RoomEntry } from "../masterserver/client.ts";
import { parseConnectTarget, resolveTarget, TargetError, type ConnectTarget } from "../masterserver/target.ts";
import { Session, type SessionEvents, type SessionOptions, type SessionState } from "./session.ts";
import { DEFAULT_UNITS_CHECKSUM, type PreregisterInfo } from "../protocol/packets/common.ts";
import { persistentClientUuid } from "../protocol/identity.ts";
import type { ServerInfoLite, TeamEntry } from "../protocol/packets/room.ts";
import type { SocksProxyTarget } from "./connection.ts";

/** 每房聊天记录条目（最近 200 条滚动）。 */
export interface ChatHistoryEntry {
  time: string;
  name: string;
  message: string;
}

/** runner 实际依赖的 Session 公共面（真实 Session 与测试 fake 都满足）。 */
export interface SessionLike {
  state: SessionState;
  info: PreregisterInfo | null;
  roster: TeamEntry[];
  roomInfo: ServerInfoLite | null;
  on<K extends keyof SessionEvents>(event: K, listener: (payload: SessionEvents[K]) => void): unknown;
  start(): Promise<void>;
  sendChat(message: string): void;
  disconnect(reason?: string): void;
}

export interface MultiRoomSnapshot {
  index: number;
  label: string;
  name: string;
  state: SessionState;
  roomId: string;
  currentPlayers: number;
  error?: string;
}

export interface MultiRoomHandle {
  readonly index: number;
  readonly name: string;
  readonly clientId: string;
  state(): SessionState;
  roomId(): string;
  roster(): TeamEntry[];
  history(): ChatHistoryEntry[];
  sendChat(text: string): void;
  disconnect(reason?: string): void;
  snapshot(): MultiRoomSnapshot;
}

export interface MultiRoomOptions {
  targets: string[];
  playerName: string;
  password?: string | null;
  language?: string;
  formatVersion?: 2 | 5;
  unitsChecksum?: number;
  networkVersion?: number;
  onInputRequest?: SessionOptions["onInputRequest"];
  relayRoomId?: string | null;
  /** 玩家名策略：suffix=第 2 个会话起加 -2/-3（默认，防同服务器重名）；same=全部同名。 */
  nameStrategy?: "suffix" | "same";
  /** clientId 基值；未设则进程内随机。每会话实际用 `${base}-m${槽位}`。 */
  clientIdBase?: string;
  /** 会话间启动间隔 ms（错峰，默认 1200）。 */
  staggerMs?: number;
  /** 单房等待进房的平坦超时 ms（默认 45000）。 */
  settleTimeoutMs?: number;
  debugFrames?: boolean;
  /** 所有会话及中继跳转共同使用的 SOCKS5 出口。 */
  socksProxy?: SocksProxyTarget;
  log: (line: string) => void;
  /** 测试注入点；缺省用真实 Session。 */
  createSession?: (target: ConnectTarget, opts: SessionOptions) => SessionLike;
}

export interface MultiRunResult {
  handles: MultiRoomHandle[];
  /** 断开全部会话。 */
  close(): Promise<void>;
}

interface RoomImpl {
  index: number;
  name: string;
  clientId: string;
  target: ConnectTarget | null;
  error?: string;
  roomId: string;
  history: ChatHistoryEntry[];
  session: SessionLike | null;
  settled: Promise<SessionState> | null;
  /** start() 抛错时唤醒结算等待（失败会话不会有状态迁移）。 */
  failed: Promise<void> | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStr(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

const TERMINAL_STATES: SessionState[] = ["battleroom", "kicked", "disconnected"];

/** 单会话进房等待：状态进入 battleroom/kicked/disconnected 即返回。 */
function settlePromise(session: SessionLike): Promise<SessionState> {
  return new Promise((resolve) => {
    if (TERMINAL_STATES.includes(session.state)) return resolve(session.state);
    let done = false;
    session.on("stateChange", (s) => {
      if (!done && TERMINAL_STATES.includes(s)) {
        done = true;
        resolve(s);
      }
    });
  });
}

/** 展开 target 表达式：list:N 只拉一次房间列表；拒绝重复目标。 */
async function expandTargets(raws: string[], log: (line: string) => void): Promise<string[]> {
  const expanded: string[] = [];
  let rooms: RoomEntry[] | null = null;
  for (const raw of raws) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^list:(-?\d+)$/);
    if (!m) {
      expanded.push(s);
      continue;
    }
    if (!rooms) {
      log("正在从主服务器拉取房间列表…");
      rooms = await listRooms();
      if (rooms.length === 0) throw new TargetError("没有公开房间");
    }
    const idx = Number(m[1]);
    const room = rooms[idx];
    if (!room) throw new TargetError(`list index ${idx} out of range (0..${rooms.length - 1})`);
    log(
      `选中列表房间 #${idx}: ${room.createdBy} | ${(room.mapPath || "?").split("/").pop()} | ` +
        `${room.currentPlayers}/${room.maxPlayers} | ${room.gameState}`,
    );
    expanded.push(roomConnectDescriptor(room));
  }
  const seen = new Set<string>();
  for (const t of expanded) {
    if (seen.has(t)) throw new TargetError(`重复目标: ${t}（同一房间进两个会话会重名互踢）`);
    seen.add(t);
  }
  if (expanded.length === 0) throw new TargetError("没有可用目标");
  return expanded;
}

export async function runMultiRooms(opts: MultiRoomOptions): Promise<MultiRunResult> {
  const log = opts.log;
  const createSession = opts.createSession ?? ((t, o) => new Session(t, o) as SessionLike);
  const staggerMs = opts.staggerMs ?? 1200;
  const settleTimeoutMs = opts.settleTimeoutMs ?? 45_000;

  // 1. 展开 + 解析目标（单房解析失败不算致命，进 summary）
  const rawTargets = opts.targets.flatMap((t) => t.split(","));
  const expanded = await expandTargets(rawTargets, log);
  const resolved = await Promise.all(
    expanded.map(async (t): Promise<ConnectTarget | { error: string }> => {
      try {
        return await resolveTarget(parseConnectTarget(t), opts.password ?? null);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // 2. 建房槽位 + 会话
  const baseUuid = opts.clientIdBase ?? persistentClientUuid();
  const rooms: RoomImpl[] = resolved.map((r, i) => ({
    index: i,
    name: opts.nameStrategy === "same" || i === 0 ? opts.playerName : `${opts.playerName}-${i + 1}`,
    clientId: `${baseUuid}-m${i + 1}`,
    target: "error" in r ? null : r,
    error: "error" in r ? r.error : undefined,
    roomId: "pending",
    history: [],
    session: null,
    settled: null,
    failed: null,
  }));

  const roomFailedResolvers = new Map<number, () => void>();

  for (const room of rooms) {
    if (!room.target) continue;
    const session = createSession(room.target, {
      playerName: room.name,
      password: opts.password ?? null,
      language: opts.language ?? "zh",
      formatVersion: opts.formatVersion ?? 5,
      unitsChecksum: opts.unitsChecksum ?? DEFAULT_UNITS_CHECKSUM,
      networkVersion: opts.networkVersion,
      onInputRequest: opts.onInputRequest,
      relayRoomId: opts.relayRoomId ?? null,
      debugFrames: opts.debugFrames ?? false,
      clientUuid: room.clientId,
      socksProxy: opts.socksProxy,
    });
    room.session = session;
    room.settled = settlePromise(session);
    room.failed = new Promise<void>((resolve) => {
      roomFailedResolvers.set(room.index, resolve);
    });
    session.on("log", (line) => log(`[#${room.index + 1}] ${line}`));
    session.on("stateChange", (s) => {
      if (s === "battleroom" && session.info?.serverUuid) {
        room.roomId = session.info.serverUuid;
        log(`[#${room.index + 1}] 已进房 roomId=${room.roomId}`);
      }
    });
    session.on("chat", (chat) => {
      const sender = chat.senderName ?? "<server>";
      room.history.push({ time: nowStr(), name: sender, message: chat.message });
      if (room.history.length > 200) room.history.splice(0, room.history.length - 200);
    });
    session.on("kicked", (reason) => log(`[#${room.index + 1}] 被踢: ${reason}`));
    session.on("disconnected", (reason) => log(`[#${room.index + 1}] 断开: ${reason}`));
  }

  // 3. 错峰启动；单房启动失败不拖垮其余，也不拖住整体结算
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i]!;
    if (!room.session) continue;
    if (i > 0) await delay(staggerMs);
    void room.session.start().catch((err) => {
      room.error = err instanceof Error ? err.message : String(err);
      log(`[#${i + 1}] 启动失败: ${room.error}`);
      roomFailedResolvers.get(room.index)?.();
    });
  }

  // 4. 等待全部到达终态（battleroom/kicked/disconnected/启动失败）
  await Promise.all(
    rooms.map(async (room) => {
      if (!room.settled || !room.failed) return;
      const settledInTime = await Promise.race([
        room.settled.then(() => true),
        room.failed.then(() => true),
        delay(settleTimeoutMs).then(() => false),
      ]);
      if (!settledInTime) room.error = room.error ?? "join timeout";
    }),
  );

  const okCount = rooms.filter((r) => r.session?.state === "battleroom").length;
  log(`多房启动完成: ${okCount}/${rooms.length} 个房间在战役室`);
  const mem = process.memoryUsage();
  log(`进程内存: RSS ${(mem.rss / 1048576).toFixed(1)}MB, heap ${(mem.heapUsed / 1048576).toFixed(1)}MB`);

  const handles: MultiRoomHandle[] = rooms.map((room) => ({
    index: room.index,
    name: room.name,
    clientId: room.clientId,
    state: () => room.session?.state ?? "idle",
    roomId: () => room.roomId,
    roster: () => room.session?.roster ?? [],
    history: () => room.history,
    sendChat: (text: string) => room.session?.sendChat(text),
    disconnect: (reason?: string) => room.session?.disconnect(reason),
    snapshot: (): MultiRoomSnapshot => ({
      index: room.index,
      label: room.target?.label ?? room.error ?? "?",
      name: room.name,
      state: room.session?.state ?? "idle",
      roomId: room.roomId,
      currentPlayers: (room.session?.roster ?? []).filter((t) => !t.isAi && t.connectionActive && t.name).length,
      ...(room.error ? { error: room.error } : {}),
    }),
  }));

  return {
    handles,
    close: async () => {
      for (const room of rooms) room.session?.disconnect("multi runner closing");
    },
  };
}
