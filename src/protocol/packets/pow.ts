import { ByteReader, ByteWriter } from "../primitives.ts";
import { integrityString } from "../integrity.ts";
import { rwSha256ShortHash } from "../hashes.ts";

/**
 * 151 RELAY_POW：服务器下发的计算挑战。
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

/** 原版 aq.i/aq.j：包未携带字段时沿用先前值。每个会话独立保存。 */
export interface PowState {
  minClientVersion: number;
  minServerVersion: number;
}

export function createPowState(): PowState {
  return { minClientVersion: 55, minServerVersion: 66 };
}

export function parsePowChallenge(payload: Buffer, state: PowState = createPowState()): PowChallenge {
  const r = new ByteReader(payload);
  const id = r.readInt();
  const type = r.readInt();
  const c: PowChallenge = { id, type, ...state };
  if (r.readBoolean()) c.minClientVersion = r.readInt();
  if (r.readBoolean()) c.minServerVersion = r.readInt();
  if (type === 5 || type === 6) {
    c.targetHash = r.readUTF();
    c.baseString = r.readUTF();
    c.maxIter = r.readInt();
    if (type === 6) {
      c.baseString = (c.baseString ?? "") + c.minClientVersion;
    }
  } else if (type === 7) {
    c.repeatUnit = r.readUTF();
    c.repeatCount = r.readInt();
  }
  // 只有完整解析成功才更新保存值，坏包不能污染后续挑战。
  state.minClientVersion = c.minClientVersion!;
  state.minServerVersion = c.minServerVersion!;
  return c;
}

/** 原版客户端求解规则（"max" 表示超过工作量上限）。 */
export function solvePowChallenge(c: PowChallenge): string {
  const minClient = c.minClientVersion ?? 55;
  const minServer = c.minServerVersion ?? 66;
  switch (c.type) {
    case 0:
      return String(minClient);
    case 1:
      return String(minServer);
    case 2:
      return integrityString(minClient);
    case 3:
    case 4:
      return rwSha256ShortHash(`${minClient}|${minServer}`);
    case 5:
    case 6: {
      const target = c.targetHash ?? "";
      const base = c.baseString ?? "";
      const maxIter = c.maxIter ?? 0;
      if (maxIter > 10_000_000) return "max";
      for (let i = 0; i <= maxIter; i++) {
        if (rwSha256ShortHash(base + i) === target) return String(i);
      }
      return "-1";
    }
    case 7: {
      const unit = c.repeatUnit ?? "";
      const count = c.repeatCount ?? 0;
      if (count > 10_000) return "max";
      return unit.repeat(Math.max(0, count));
    }
    default:
      return "";
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
