import { getGameServer } from "./client.ts";

/** 连接目标：已解析到可直接拨号，或需要经主服务器 get 解析。 */
export interface ConnectTarget {
  host: string;
  port: number;
  /** 中继查询串（连接串里的路径部分，如房间代码）。 */
  queryString?: string;
  /** get| 描述符的房间 id（用于 p_hash 密码）。 */
  gameId?: string;
  label: string;
}

export class TargetError extends Error {}

/**
 * 解析用户输入的连接目标。支持：
 *  - get|serverId|code|needsPassword|port  （列表房间描述符）
 *  - host:port  /  host  （直连，默认端口 5123）
 *  - rxxxx 之类房间代码（>4 字符且无 . : / \）→ 首字母中继
 *  - xxx.relay（自动补 .corrodinggames.com）
 *  - [TCP]host:port 前缀被剥除
 * 对齐 NetworkEngine.b(String, boolean) 的判定顺序。
 */
export function parseConnectTarget(inputRaw: string): DirectTarget | RelayTarget | GetTarget {
  let s = inputRaw.trim();
  if (s.length === 0) throw new TargetError("empty target");

  if (s.startsWith("get|")) {
    const parts = s.split("|");
    if (parts.length < 5) throw new TargetError(`bad get| descriptor: ${s}`);
    const gameId = parts[1]!;
    const code = Number(parts[2]);
    const needsPassword = parts[3] === "true";
    const port = Number(parts[4]);
    if (!gameId || !Number.isFinite(code) || !Number.isFinite(port)) {
      throw new TargetError(`bad get| descriptor fields: ${s}`);
    }
    return { kind: "get", gameId, serverCode: code, needsPassword, port, label: s };
  }

  if (s.toLowerCase().endsWith(".relay")) {
    s = s + ".corrodinggames.com";
  }
  if (s.startsWith("[TCP]")) {
    s = s.slice("[TCP]".length);
  }

  // 房间代码：无 . : / \ 、非 localhost、长度 > 4 → 首字母中继
  if (
    s.length > 4 &&
    !s.includes(":") &&
    !s.includes(".") &&
    s !== "localhost" &&
    !s.includes("/") &&
    !s.includes("\\")
  ) {
    const host = `${s.charAt(0)}.relay.corrodinggames.com`;
    return { kind: "direct", host, port: 5123, queryString: s, label: `${host}/${s}` };
  }

  // 路径部分 → 查询串（中继路由用）
  let queryString: string | undefined;
  const slash = s.indexOf("/");
  const backslash = s.indexOf("\\");
  let cut = slash === -1 ? s.length : slash;
  if (backslash !== -1 && backslash < cut) cut = backslash;
  if (cut < s.length) {
    const q = s.slice(cut + 1).trim();
    if (q.length > 0) queryString = q;
    s = s.slice(0, cut);
  }

  let host = s;
  let port = 5123;
  const colonParts = s.split(":");
  if (colonParts.length > 1) {
    host = colonParts.slice(0, -1).join(":");
    const portStr = colonParts[colonParts.length - 1]!;
    const p = Number(portStr);
    if (!Number.isFinite(p)) throw new TargetError(`bad port: ${portStr}`);
    port = p;
  }
  if (host.length === 0) throw new TargetError(`bad host in: ${inputRaw}`);
  return { kind: "direct", host, port, queryString, label: `${host}:${port}${queryString ? "/" + queryString : ""}` };
}

export interface DirectTarget {
  kind: "direct";
  host: string;
  port: number;
  queryString?: string;
  label: string;
}

export interface RelayTarget {
  kind: "direct";
  host: string;
  port: 5123;
  queryString: string;
  label: string;
}

export interface GetTarget {
  kind: "get";
  gameId: string;
  serverCode: number;
  needsPassword: boolean;
  port: number;
  label: string;
}

/** 将任意目标解析为最终可拨号的 ConnectTarget（get| 需要网络请求）。 */
export async function resolveTarget(
  target: DirectTarget | RelayTarget | GetTarget,
  password?: string | null,
): Promise<ConnectTarget> {
  if (target.kind === "direct") {
    return {
      host: target.host,
      port: target.port,
      queryString: target.queryString,
      label: target.label,
    };
  }
  const server = await getGameServer(target.gameId, target.serverCode, password ?? null);
  return {
    host: server.host,
    port: server.port,
    gameId: target.gameId,
    label: `${target.gameId} → ${server.host}:${server.port}`,
  };
}
