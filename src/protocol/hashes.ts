import { createHash } from "node:crypto";

/** sha256 十六进制（小写），对齐 Utility.sha256Hex。 */
export function sha256Hex(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** sha256 十六进制截前 n 字符，对齐 Utility.truncateToLength(toHexString(sha256Bytes(s)), n)。 */
export function sha256HashN(str: string, n: number): string {
  return sha256Hex(str).slice(0, n);
}

/** Utility.sha256ShortHash：截 14。 */
export function sha256ShortHash(str: string): string {
  return sha256HashN(str, 14);
}

/** Utility.sha256Fingerprint：截 4。 */
export function sha256Fingerprint(str: string): string {
  return sha256HashN(str, 4);
}

export function md5Hex(str: string): string {
  return createHash("md5").update(str, "utf8").digest("hex");
}

/** Utility.repeatHash(str, n)：sha256 后再迭代 n 次 sha256（共 n+1 次）。 */
export function repeatHash(str: string, n: number): string {
  let h = sha256Hex(str);
  for (let i = 0; i < n; i++) h = sha256Hex(h);
  return h;
}

/**
 * RW-HPS PoW 哈希格式：new BigInteger(1, sha256(bytes)).toString(16).toUpperCase()
 * 再截前 14 位。注意 BigInteger.toString 会丢弃前导零（与 RW 客户端的
 * %064X 补零格式在哈希首半字节为 0 时不同——以服务器侧生成为准）。
 */
export function rwhpsPowHash14(str: string): string {
  const hex = createHash("sha256").update(str, "utf8").digest("hex");
  return hex.replace(/^0+/, "").toUpperCase().slice(0, 14);
}
