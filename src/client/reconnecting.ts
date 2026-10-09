import { EventEmitter } from "node:events";
import { Session, type SessionEvents, type SessionOptions, type SessionState } from "./session.ts";
import { parseConnectTarget, resolveTarget, TargetError, type ConnectTarget } from "../masterserver/target.ts";
import { persistentClientUuid } from "../protocol/identity.ts";

export interface ReconnectOptions {
  enabled?: boolean;
  /** 一次 start 的总重试次数，默认 10；成功入房不重置，避免短连接循环。 */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ReconnectDependencies {
  resolve?: (raw: string, password?: string | null) => Promise<ConnectTarget>;
  createSession?: (target: ConnectTarget, options: SessionOptions) => ReconnectSessionSource;
  random?: () => number;
}

/** 最小会话契约；允许多房 runner 的已有测试/自定义会话工厂。 */
export interface ReconnectSessionSource {
  state: SessionState;
  info: Session["info"];
  roster: Session["roster"];
  roomInfo: Session["roomInfo"];
  settings?: Session["settings"];
  phase?: Session["phase"];
  pingMs?: Session["pingMs"];
  slotCount?: Session["slotCount"];
  yourTeamId?: Session["yourTeamId"];
  gameStartInfo?: Session["gameStartInfo"];
  serverEnded?: boolean;
  pendingInputRequest?: Session["pendingInputRequest"];
  on<K extends keyof SessionEvents>(event: K, listener: (payload: SessionEvents[K]) => void): unknown;
  start(): Promise<void>;
  sendChat(text: string): boolean | void;
  disconnect(reason?: string): void;
}

export function reconnectDelay(attempt: number, base = 5000, cap = 60000, random = Math.random): number {
  return Math.min(cap, Math.round(Math.min(cap, base * 2 ** Math.min(attempt, 30)) * (0.9 + random() * 0.2)));
}

function terminalReason(reason: string): boolean {
  return /room not found|房间.*(?:不存在|关闭)|找不到这个服务器|password|密码|banned|kicked|封禁|被踢|invalid|bad 161|frame decode|input |version mismatch|incompatible|版本.*不匹配|redirect limit|no target|bad host|bad port/i.test(reason);
}

declare interface ReconnectingSession {
  on<K extends keyof SessionEvents>(event: K, listener: (payload: SessionEvents[K]) => void): this;
}

/** 可选策略层；Session 只检测断线，CNKD 等外部 Worker 可继续直接使用 Session。 */
class ReconnectingSession extends EventEmitter {
  private current: ReconnectSessionSource | null = null;
  private currentState: SessionState = "idle";
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private generation = 0;
  private retries = 0;
  private readonly options: SessionOptions;

  constructor(
    private readonly rawTarget: string,
    options: SessionOptions,
    private readonly retry: ReconnectOptions = {},
    private readonly deps: ReconnectDependencies = {},
  ) {
    super();
    for (const value of [retry.maxRetries ?? 10, retry.baseDelayMs ?? 5000, retry.maxDelayMs ?? 60000]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid reconnect configuration");
    }
    this.options = { ...options, clientUuid: options.clientUuid ?? persistentClientUuid() };
  }

  get state(): SessionState { return this.currentState; }
  get info() { return this.current?.info ?? null; }
  get roster() { return this.current?.roster ?? []; }
  get roomInfo() { return this.current?.roomInfo ?? null; }
  get settings() { return this.current?.settings ?? {}; }
  get phase() { return this.current?.phase ?? "lobby"; }
  get pingMs() { return this.current?.pingMs ?? null; }
  get slotCount() { return this.current?.slotCount ?? null; }
  get yourTeamId() { return this.current?.yourTeamId ?? -1; }
  get gameStartInfo() { return this.current?.gameStartInfo ?? null; }
  get serverEnded() { return this.current?.serverEnded ?? false; }
  get pendingInputRequest() { return this.current?.pendingInputRequest ?? null; }
  get reconnectCount() { return this.retries; }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.clearRetry();
    this.current?.disconnect("replaced managed session");
    this.current = null;
    this.stopped = false;
    this.retries = 0;
    await this.attempt(generation);
  }

  private async attempt(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    this.current = null;
    this.setState("connecting");
    let session: ReconnectSessionSource | null = null;
    let finished = false;
    const isCurrent = () => generation === this.generation && this.current === session;
    const finish = (reason: string, terminal = false) => {
      if (finished || !isCurrent()) return;
      finished = true;
      this.scheduleRetry(reason, generation, terminal || !!session?.serverEnded);
    };
    try {
      const resolve = this.deps.resolve ?? ((raw, password) => resolveTarget(parseConnectTarget(raw), password));
      const target = await resolve(this.rawTarget, this.options.password);
      if (this.stopped || generation !== this.generation) return;
      session = (this.deps.createSession ?? ((t, o) => new Session(t, o)))(target, this.options);
      this.current = session;
      for (const event of ["chat", "rosterChange", "roomInfo", "settingsChange", "gameStart", "phaseChange", "gameEnded", "inputRequest", "log"] as const) {
        session.on(event, (payload) => { if (isCurrent()) this.emit(event, payload); });
      }
      session.on("stateChange", (state) => { if (isCurrent()) this.setState(state); });
      session.on("kicked", (reason) => {
        if (!isCurrent()) return;
        if (this.currentState !== "kicked") this.setState("kicked");
        this.emit("kicked", reason);
        finish(reason, true);
      });
      session.on("disconnected", (reason) => {
        if (!isCurrent()) return;
        this.emit("disconnected", reason);
        finish(reason);
      });
      await session.start();
    } catch (error) {
      if (generation !== this.generation || this.stopped || finished) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (session) session.disconnect(reason);
      else {
        this.setState("disconnected");
        this.emit("disconnected", reason);
        finish(reason, error instanceof TargetError);
      }
      if (!this.retry.enabled) throw error;
    }
  }

  private scheduleRetry(reason: string, generation: number, terminal: boolean): void {
    if (this.stopped || generation !== this.generation || this.retryTimer) return;
    if (!this.retry.enabled || terminal || terminalReason(reason) || this.retries >= (this.retry.maxRetries ?? 10)) {
      this.stopped = true;
      return;
    }
    const delay = reconnectDelay(this.retries++, this.retry.baseDelayMs, this.retry.maxDelayMs, this.deps.random);
    this.emit("log", `[${this.rawTarget}] reconnect #${this.retries} in ${delay}ms: ${reason}`);
    if (this.stopped || generation !== this.generation) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt(generation).catch((error) => this.emit("log", `reconnect failed: ${String(error)}`));
    }, delay);
  }

  private setState(state: SessionState): void {
    this.currentState = state;
    this.emit("stateChange", state);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  sendChat(message: string): boolean {
    if (this.stopped || this.currentState !== "battleroom" || !this.current) return false;
    return this.current.sendChat(message) !== false;
  }

  disconnect(reason = "headless client leaving"): void {
    this.stopped = true;
    this.clearRetry();
    if (this.current) this.current.disconnect(reason);
    else if (this.currentState !== "disconnected") { this.setState("disconnected"); this.emit("disconnected", reason); }
    this.generation++;
  }
}

export { ReconnectingSession };
