import { ByteReader, ByteWriter } from "../primitives.ts";
import { integrityString } from "../integrity.ts";
import { rwhpsPowHash14 } from "../hashes.ts";

/**
 * 151 RELAY_POW：服务器下发的计算挑战（原版 RW 服务器/中继使用；RWX 自身不发送）。
 * 类型 0-7，对齐 NetworkEngine case 151 的客户端求解逻辑，应答经 152 回传。
 */

export interface PowChallenge {
  id: number;
  type: number;
  minClientVersion: number | null;
  minServerVersion: number | null;
  /** type 5/6 */
  targetHash?: string;
  baseString?: string;
  maxIter?: number;
  /** type 7 */
  repeatUnit?: string;
  repeatCount?: number;
}

export function parsePowChallenge(payload: Buffer): PowChallenge {
  const r = new ByteReader(payload);
  const id = r.readInt();
  const type = r.readInt();
  const c: PowChallenge = { id, type, minClientVersion: null, minServerVersion: null };
  if (r.readBoolean()) c.minClientVersion = r.readInt();
  if (r.readBoolean()) c.minServerVersion = r.readInt();
  if (type === 5 || type === 6) {
    c.targetHash = r.readUTF();
    c.baseString = r.readUTF();
    c.maxIter = r.readInt();
    if (type === 6 && c.minClientVersion !== null) {
      c.baseString = (c.baseString ?? "") + c.minClientVersion;
    }
  } else if (type === 7) {
    c.repeatUnit = r.readUTF();
    c.repeatCount = r.readInt();
  }
  return c;
}

/** 求解挑战。返回应答串（"max" 表示放弃）。哈希格式按 RW-HPS 侧生成逻辑。 */
export function solvePowChallenge(c: PowChallenge): string {
  const minClient = c.minClientVersion ?? 0;
  const minServer = c.minServerVersion ?? 0;
  switch (c.type) {
    case 0:
      return String(minClient);
    case 1:
      return String(minServer);
    case 2:
      // RW-HPS 从不下发 type 2（构造时映射为 5），且其校验恒真；给 g() 兜底
      return integrityString(minClient);
    case 3:
    case 4:
      // RW-HPS: BigInteger(sha256(init1 + "|" + init2)).toString(16).upper().cut(14)
      return rwhpsPowHash14(`${minClient}|${minServer}`);
    case 5:
    case 6: {
      const target = c.targetHash ?? "";
      const base = c.baseString ?? "";
      const maxIter = c.maxIter ?? 0;
      if (maxIter > 10_000_000) return "max";
      for (let i = 0; i <= maxIter; i++) {
        if (rwhpsPowHash14(base + i) === target) return String(i);
      }
      return "-1";
    }
    case 7: {
      const unit = c.repeatUnit ?? "";
      const count = c.repeatCount ?? 0;
      if (count > 10_000) return "max";
      return unit.repeat(count);
    }
    default:
      return "-1";
  }
}

/** 152 RELAY_POW_RECEIVE：应答。elapsed 为耗时秒（float，写真实值即可）。 */
export function buildPowResponse(id: number, type: number, answer: string, elapsedSec: number): Buffer {
  const w = new ByteWriter();
  w.writeInt(id);
  w.writeInt(type);
  w.writeUTF(answer);
  w.writeFloat(elapsedSec);
  return w.toBuffer();
}
