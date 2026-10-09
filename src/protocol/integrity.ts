import { md5Hex } from "./hashes.ts";

/**
 * 注册完整性公式 g() 与相关校验串——移植自 RW NetworkEngine。
 *
 * 关键点：所有算术按 Java int（32 位回绕）执行；t1 段是 double，
 * 字符串化遵循 Java Double.toString 的格式（如 "4.4E10"）。
 */

/** NetworkEngine.e(x)：起始资金档位表。 */
export function creditTier(x: number): number {
  switch (x) {
    case 0: return 4000;
    case 1: return 0;
    case 2: return 1000;
    case 3: return 2000;
    case 4: return 5000;
    case 5: return 10000;
    case 6: return 50000;
    case 7: return 100000;
    case 8: return 200000;
    default: return 999;
  }
}

/** Java int 乘/加后的 32 位回绕（输入先按 float64 精确计算再截断）。 */
function javaInt(v: number): number {
  return v | 0;
}

/**
 * Java Double.toString 的子集实现（覆盖 g() 会产生的值域）。
 * 规则：|v| 在 [1e-3, 1e7) 用十进制（至少一位小数），否则用科学计数 d.dddEn。
 * JS 与 Java 都输出"最短往返十进制"，此实现只做格式对齐。
 */
export function javaDoubleToString(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const neg = v < 0;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e-3 && a < 1e7) {
    s = a.toString();
    if (!s.includes(".")) s += ".0";
  } else {
    let [mant, exp] = a.toExponential().split("e");
    if (!mant!.includes(".")) mant = mant! + ".0";
    else mant = mant!.replace(/0+$/, "").replace(/\.$/, ".0");
    const expNum = Number(exp);
    s = `${mant}E${expNum}`;
  }
  return neg ? `-${s}` : s;
}

/** PlayerTeam.TEAM_SELF.credits（WaveTeam 经 PlayerTeam() 构造，=4000.0）。 */
const TEAM_SELF_CREDITS = 4000.0;

/**
 * NetworkEngine.g(i)：注册包 110 的完整性应答串（i2=5 模式）。
 * 注意：`7:` 字段原版 RW 为 e(7)*18*i（乘法，2026-09 从真实原版客户端抓包验证），
 * 可读重建源码里出现过加法；此处始终按两份原始反编译和抓包确认的乘法执行。
 * `d:` 段恒为 5*i（判断式两侧为同一表达式）。
 */
export function integrityString(seed: number): string {
  const mul7 = javaInt(creditTier(7) * 18 * seed);
  const t1 = javaDoubleToString(TEAM_SELF_CREDITS * 11.0 * seed);
  const s =
    `c:${seed}` +
    `m:${javaInt(seed * 87 + 24)}` +
    `0:${javaInt(creditTier(0) * 11 * seed)}` +
    `1:${javaInt(creditTier(1) * 12 + seed)}` +
    `2:${javaInt(creditTier(2) * 13 * seed)}` +
    `3:${javaInt(creditTier(3) * 14 + seed)}` +
    `4:${javaInt(creditTier(4) * 15 * seed)}` +
    `5:${javaInt(creditTier(5) * 16 + seed)}` +
    `6:${javaInt(creditTier(6) * 17 * seed)}` +
    `7:${mul7}` +
    `8:${javaInt(creditTier(8) * 19 * seed)}` +
    `t1:${t1}` +
    `d:${javaInt(5 * seed)}`;
  return s;
}

/** NetworkEngine.h(i)：额外校验 = Utility.toHexString(int) = "#%06X"（低 24 位）。 */
export function extraCheckString(v: number): string {
  return "#" + (v & 0xffffff).toString(16).toUpperCase().padStart(6, "0");
}

/**
 * MasterServerClient.formatServerCode(n)：主服务器 action=get 的 c 参数。
 * 高段位代码内嵌 g() 公式。
 */
export function formatServerCode(n: number): string {
  if (n === 0) return "";
  if (n > 0) {
    if (n < 100000) return md5Hex("x" + n).slice(0, 10);
    if (n < 200000) return md5Hex("y" + n).slice(0, 11);
    if (n < 300000) return md5Hex("z" + n).slice(0, 12);
    if (n < 1000000) return md5Hex("xx" + n).slice(0, 13) + "-" + integrityString(n - 300000);
    if (n < 2000000) return md5Hex("yy" + n).slice(0, 14) + "-" + integrityString(n - 1000000);
  }
  return "NA";
}
