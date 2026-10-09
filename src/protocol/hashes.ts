import { createHash } from "node:crypto";

/** 通用 SHA-256 小写十六进制；原版 RW 线路字段使用 rwSha256Hex。 */
export function sha256Hex(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** 原版 f.e(String)：固定 64 位、大写十六进制，不删除前导零。 */
export function rwSha256Hex(str: string): string {
  return sha256Hex(str).toUpperCase();
}

/** 原版 f.c(String)：大写、补零后截前 14 位。 */
export function rwSha256ShortHash(str: string): string {
  return rwSha256Hex(str).slice(0, 14);
}

/** 通用小写 SHA-256 前 n 位；原版线路字段用 rwSha256ShortHash。 */
export function sha256HashN(str: string, n: number): string {
  return sha256Hex(str).slice(0, n);
}

/** 通用小写 SHA-256 前 14 位。 */
export function sha256ShortHash(str: string): string {
  return sha256HashN(str, 14);
}

/** 通用小写 SHA-256 前 4 位。 */
export function sha256Fingerprint(str: string): string {
  return sha256HashN(str, 4);
}

export function md5Hex(str: string): string {
  return createHash("md5").update(str, "utf8").digest("hex");
}

/** 原版 f.c(str, n)：每轮的大写哈希串参与下一轮，共 n+1 次。 */
export function repeatHash(str: string, n: number): string {
  let h = rwSha256Hex(str);
  for (let i = 0; i < n; i++) h = rwSha256Hex(h);
  return h;
}

/**
 * RW-HPS PoW 哈希格式：new BigInteger(1, sha256(bytes)).toString(16).toUpperCase()
 * 再截前 14 位。注意 BigInteger.toString 会丢弃前导零（与 RW 客户端的
 * %064X 补零格式在哈希首半字节为 0 时不同）。保留历史辅助函数，原版会话不使用。
 */
export function rwhpsPowHash14(str: string): string {
  return rwSha256Hex(str).replace(/^0+/, "").slice(0, 14);
}
