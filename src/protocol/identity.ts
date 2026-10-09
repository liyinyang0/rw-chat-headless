import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 身份文件固定在仓库根 data/ 下（src/protocol/ 上两级）。 */
const IDENTITY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "client-uuid");

/**
 * 读取或创建客户端身份文件：文件不存在或内容非法时生成新随机 UUID 写入（0600）。
 * 目录不存在会一并创建；文件系统不可写时退化为仅本次进程有效的随机值。
 */
export function loadOrCreateClientUuid(file: string): string {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    /* 首次运行或不可读：走生成路径 */
  }
  const generated = randomUUID();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  } catch {
    /* 只读环境：身份仅本次进程内稳定 */
  }
  return generated;
}

let cached: string | null = null;

/**
 * 默认客户端身份：首次调用时生成随机 UUID 并持久化到 data/client-uuid，
 * 之后跨进程重启复用同一身份——每个部署一份、互不相同。
 * 优先级：调用方显式传入 > 环境变量 CLIENT_UUID > 本持久身份。
 * 要换身份：删除 data/client-uuid，或设置 CLIENT_UUID 覆盖。
 */
export function persistentClientUuid(): string {
  cached ??= loadOrCreateClientUuid(IDENTITY_FILE);
  return cached;
}
