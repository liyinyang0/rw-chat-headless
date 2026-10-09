import { formatServerCode } from "../protocol/integrity.ts";
import { repeatHash, sha256ShortHash } from "../protocol/hashes.ts";

/** 主服务器接口（与官方客户端一致）。 */
export const MASTER_SERVER_URLS = [
  "http://gs1.corrodinggames.com/masterserver/1.4/interface",
  "http://gs4.corrodinggames.net/masterserver/1.4/interface",
];

export interface RoomEntry {
  serverId: string;
  publicHost: string;
  lanHost: string;
  port: number;
  isPortOpen: boolean;
  requiresPassword: boolean;
  createdBy: string;
  mapPath: string;
  gameMode: string;
  gameState: string;
  gameVersionCode: number;
  gameVersionString: string;
  isLanServer: boolean;
  currentPlayers: number;
  maxPlayers: number;
  isDedicatedServer: boolean;
  hasMods: boolean;
  modsRequired: string | null;
  gameVersionNumber: number;
  rawColumns: string[];
}

function parseListLine(line: string): RoomEntry | null {
  const cols = line.split(",", -1);
  if (cols.length <= 21) return null;
  const num = (s: string | undefined, fallback = -1) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (s: string | undefined) => s === "true";
  const serverId = (cols[18] ?? "").trim() || (cols[0] ?? "");
  let modsRequired: string | null = cols[20] ?? null;
  if (modsRequired === "") modsRequired = null;
  return {
    serverId,
    publicHost: cols[3] ?? "",
    lanHost: cols[4] ?? "",
    port: num(cols[5], 5123),
    isPortOpen: bool(cols[6]),
    requiresPassword: bool(cols[8]),
    createdBy: cols[7] ?? "",
    mapPath: cols[9] ?? "",
    gameMode: cols[10] ?? "",
    gameState: cols[11] ?? "",
    gameVersionCode: num(cols[2]),
    gameVersionString: cols[12] ?? "",
    isLanServer: bool(cols[13]),
    currentPlayers: num(cols[15]),
    maxPlayers: num(cols[16], 8),
    isDedicatedServer: bool(cols[17]),
    hasMods: bool(cols[19]),
    modsRequired,
    gameVersionNumber: num(cols[21]),
    rawColumns: cols,
  };
}

class MasterServerError extends Error {}

function responseLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  if (!header.startsWith("CORRODINGGAMES")) throw new Error("master server bad header");
  if (header.includes("[FAILED]")) {
    const error = lines[1] ?? "";
    if (error.startsWith("ERROR_WRONG_PASSWORD")) throw new MasterServerError("Wrong password");
    if (error.startsWith("ERROR_MISSING_PASSWORD")) throw new MasterServerError("Missing password");
    if (error.startsWith("ERROR_WRONG_C")) throw new MasterServerError("Wrong server code");
    if (error.startsWith("ERROR_MISSING")) throw new MasterServerError("Request missing required fields");
    throw new MasterServerError(`master server failed: ${error.slice(0, 80)}`);
  }
  return lines;
}

async function fetchFirstValid<T>(path: string, parse: (text: string) => T, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const controllers = MASTER_SERVER_URLS.map(() => new AbortController());
  const attempts = MASTER_SERVER_URLS.map(async (base, index) => {
    const ctrl = controllers[index]!;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        ...init,
        signal: ctrl.signal,
        headers: {
          "User-Agent": "rw pc 176 en",
          Language: "en",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 每个节点都必须完成协议校验才能赢得竞争。
      return parse(await res.text());
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch (error) {
    if (error instanceof AggregateError) {
      throw error.errors.find((item) => item instanceof MasterServerError)
        ?? error.errors.find((item) => item instanceof Error)
        ?? new Error("No valid master-server response");
    }
    throw error;
  } finally {
    for (const controller of controllers) controller.abort();
  }
}

/** 拉取公开房间列表。 */
export async function listRooms(): Promise<RoomEntry[]> {
  return await fetchFirstValid(
    `?action=list&game_version=176&game_version_beta=false`,
    (text) => {
      const lines = responseLines(text);
      const rooms: RoomEntry[] = [];
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const entry = parseListLine(line);
        if (entry) rooms.push(entry);
      }
      return rooms;
    },
  );
}

export interface ResolvedGameServer {
  host: string;
  port: number;
}

/** action=get：由 serverId+code 换取真实地址（列表房间进入路径）。 */
export async function getGameServer(
  gameId: string,
  serverCode: number,
  password?: string | null,
): Promise<ResolvedGameServer> {
  const params = new URLSearchParams({
    action: "get",
    game_id: gameId,
    c: formatServerCode(serverCode),
  });
  if (password != null) params.set("p_hash", repeatHash(gameId + password, 3));
  return await fetchFirstValid(``, (text) => {
    const lines = responseLines(text);
    const check = lines[2] ?? "";
    if (!check.toLowerCase().includes(sha256ShortHash("game_" + formatServerCode(serverCode)).toLowerCase())) {
      throw new Error("master server integrity line mismatch");
    }
    const csv = (lines[4] ?? "").split(",", -1);
    if (csv.length <= 18) throw new Error(`master server csv too short: ${csv.length}`);
    const host = csv[3] ?? "";
    const port = Number(csv[5]);
    if (!host || /[\s\u0000-\u001f\u007f]/.test(host) || !/^\d+$/.test(csv[5] ?? "")
      || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("master server returned invalid address or port");
    return { host, port };
  }, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

/** 列表房间 → 连接描述符（对齐 ServerInfo.getConnectDescriptor）。 */
export function roomConnectDescriptor(room: RoomEntry): string {
  if (room.gameVersionNumber === 0) {
    return `${room.publicHost}:${room.port}`;
  }
  return `get|${room.serverId.replace(/\|/g, ".")}|${room.gameVersionNumber}|${room.requiresPassword}|${room.port}`;
}
