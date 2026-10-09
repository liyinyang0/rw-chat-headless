import { ByteReader } from "../primitives.ts";
import { inflateBlock, readBlock, skipBlock } from "../block.ts";

export interface TeamEntry {
  /** 玩家槽位/位置。保留 teamId 兼容旧调用方。 */
  teamId: number;
  slotId: number;
  /** 原版协议里的 teamColorId/联盟队编号。 */
  allyTeamId: number | null;
  /** 玩家名（队伍名）。 */
  name: string | null;
  isSpectator: boolean;
  /** 连接是否在线（掉线重连窗口内为 false）。 */
  connectionActive: boolean;
  pingMs: number;
  /** AI 队伍。 */
  isAi: boolean;
  /** 原始 hostTeamFlag；语义需真实抓包确认后才可作为房主标识展示。 */
  hostFlag: number | null;
  /** 玩家覆盖色/最终分配色，旧服务端不可用时为 null。 */
  assignedColorIndex: number | null;
}

export interface TeamListResult {
  yourTeamId: number;
  teams: TeamEntry[];
  /** true 表示只含网络在线状态的精简增量，必须与上一次完整名单合并。 */
  delta: boolean;
  /** 协议发送的槽位数；在真实包验证前不得直接宣传为人数上限。 */
  slotCount: number;
  /** 块外房间设置（尽力解析）。 */
  settings: RoomSettingsLite;
}

export interface RoomSettingsLite {
  fogMode?: number;
  startingCredits?: number;
  revealedMap?: boolean;
  aiDifficulty?: number;
  currentUnitCap?: number;
  maxUnitCap?: number;
  startingUnits?: number;
  incomeMultiplier?: number;
  noNukes?: boolean;
}

/**
 * 解析 115 TEAM_LIST，提取玩家名册。
 * 只消费 teams 块内字段；块外设置尽力读，customUnits 直接跳过。
 *
 * 兼容 streamVersion >= 90（含 >=141 的 gzip 块）。更老的 8 队无块格式
 * 在现代服务器上已不可见，不做支持（解析失败会抛 ProtocolError）。
 */
export function parseTeamList(payload: Buffer, streamVersion: number): TeamListResult {
  const r = new ByteReader(payload);
  const yourTeamId = r.readInt();
  let fullUpdate = false;
  if (streamVersion >= 141) {
    fullUpdate = r.readBoolean();
  }
  let count = 8;
  if (streamVersion >= 90) {
    count = r.readInt();
  }

  const teams: TeamEntry[] = [];
  if (streamVersion >= 90) {
    const block = readBlock(r);
    const data = streamVersion >= 141 ? inflateBlock(block) : block.data;
    const inner = new ByteReader(data);
    for (let i = 0; i < count; i++) {
      if (!inner.readBoolean()) continue;
      const isAi = inner.readInt() !== 0;
      if (fullUpdate) {
        // writeNetworkTeamUpdate：byte + teamNetworkId + connActive + netActive
        const teamId = inner.readByte();
        inner.readInt();
        const connectionActive = inner.readBoolean();
        inner.readBoolean();
        teams.push({
          teamId,
          slotId: teamId,
          allyTeamId: null,
          name: null,
          isSpectator: false,
          connectionActive,
          pingMs: -1,
          isAi,
          hostFlag: null,
          assignedColorIndex: null,
        });
      } else {
        teams.push(readBasicTeamState(inner, streamVersion, isAi));
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (!r.readBoolean()) continue;
      const isAi = r.readInt() !== 0;
      teams.push(readBasicTeamState(r, streamVersion, isAi));
    }
  }

  const settings: RoomSettingsLite = {};
  try {
    settings.fogMode = r.readInt();
    settings.startingCredits = r.readInt();
    settings.revealedMap = r.readBoolean();
    settings.aiDifficulty = r.readInt();
    const settingsVersion = r.readUnsignedByte();
    settings.currentUnitCap = r.readInt();
    settings.maxUnitCap = r.readInt();
    if (settingsVersion >= 2) {
      settings.startingUnits = r.readInt();
      settings.incomeMultiplier = r.readFloat();
      settings.noNukes = r.readBoolean();
      r.readBoolean(); // j
    }
    if (settingsVersion >= 3 && r.readBoolean()) {
      skipBlock(r); // customUnits：不做校验，直接跳过（mod 房零成本进入的关键）
    }
    // 剩余 sharedControl/gamePaused 等不再消费
  } catch {
    // 设置段解析失败不影响名册
  }

  return { yourTeamId, teams, delta: fullUpdate, slotCount: count, settings };
}

/** PlayerTeam.writeBasicTeamState 的读侧（streamVersion 分支对齐源码）。 */
function readBasicTeamState(r: ByteReader, sv: number, isAi: boolean): TeamEntry {
  const teamId = r.readByte();
  r.readInt(); // credits
  const allyTeamId = r.readInt();
  const name = r.readNullableString();
  r.readBoolean(); // isTeamObserver
  let pingMs = -1;
  let isSpectator = false;
  let connectionActive = true;
  if (sv > 26) {
    r.readInt(); // teamNetworkId
    r.readLong(); // teamLastPingTime
  }
  if (sv >= 55) {
    isSpectator = r.readBoolean();
    pingMs = r.readInt();
  }
  if (sv >= 91) {
    r.readInt(); // teamSortIndex
    r.readByte(); // 保留
  }
  if (sv >= 97) {
    connectionActive = r.readBoolean();
    r.readBoolean(); // isTeamNetworkActive
  }
  if (sv >= 125) {
    r.readBoolean(); // isTeamVictory
    r.readBoolean(); // teamSurrenderTriggered
    r.readInt(); // surrenderVoteTimeMillis
  }
  let hostFlag: number | null = null;
  if (sv >= 149) {
    r.readNullableString(); // teamAIHint（普通直连玩家为 null）
    hostFlag = r.readInt();
  }
  let assignedColorIndex: number | null = null;
  if (sv >= 156) {
    r.readNullableInt(); // teamAIDifficultyOverride
    r.readNullableInt(); // startingUnitsOverride
    r.readNullableInt(); // teamAILevelOverride
    r.readNullableInt(); // playerColorOverride
    assignedColorIndex = r.readInt();
  }
  return {
    teamId,
    slotId: teamId,
    allyTeamId,
    name,
    isSpectator,
    connectionActive,
    pingMs,
    isAi,
    hostFlag,
    assignedColorIndex,
  };
}

export interface ServerInfoLite {
  networkVersion: number;
  gameModeOrdinal: number | null;
  mapPath: string | null;
  fogMode: number;
  startingCredits: number;
  revealedMap: boolean;
  aiDifficulty: number;
  currentUnitCap: number;
  maxUnitCap: number;
  startingUnits: number | null;
  incomeMultiplier: number | null;
  noNukes: boolean | null;
  sharedControl: boolean | null;
  teamLock: boolean | null;
  fixedAllyTeams: boolean | null;
  roomLock: boolean | null;
  allowSpectators: boolean | null;
  hasCustomUnits: boolean;
}

/**
 * 解析 106 SERVER_INFO（进房时服务器推送的房间设置）。
 * customUnits 块跳过不校验。
 */
export function parseServerInfo(payload: Buffer): ServerInfoLite {
  const r = new ByteReader(payload);
  r.readUTF(); // magic
  const networkVersion = r.readInt();
  const gameModeOrdinal = r.readInt(); // writeEnumOrdinal
  const mapPath = r.readUTF();
  const startingCredits = r.readInt();
  const fogMode = r.readInt();
  const revealedMap = r.readBoolean();
  const aiDifficulty = r.readInt();
  const settingsVersion = r.readUnsignedByte(); // 服务器写 8
  r.readBoolean(); // isProxyController
  r.readBoolean(); // G
  const currentUnitCap = r.readInt();
  const maxUnitCap = r.readInt();
  let incomeMultiplier: number | null = null;
  let startingUnits: number | null = null;
  let noNukes: boolean | null = null;
  if (settingsVersion >= 2) {
    startingUnits = r.readInt();
    incomeMultiplier = r.readFloat();
    noNukes = r.readBoolean();
    r.readBoolean(); // j
  }
  let hasCustomUnits = false;
  if (settingsVersion >= 3 && r.readBoolean()) {
    skipBlock(r);
    hasCustomUnits = true;
  }
  let sharedControl: boolean | null = null;
  let teamLock: boolean | null = null;
  let fixedAllyTeams: boolean | null = null;
  let allowSpectators: boolean | null = null;
  let roomLock: boolean | null = null;
  if (settingsVersion >= 4) sharedControl = r.readBoolean();
  if (settingsVersion >= 5) teamLock = r.readBoolean();
  if (settingsVersion >= 6) fixedAllyTeams = r.readBoolean();
  if (settingsVersion >= 7) {
    allowSpectators = r.readBoolean();
    roomLock = r.readBoolean();
  }
  if (settingsVersion >= 8) {
    r.readInt(); // randomSeed
  }
  return {
    networkVersion,
    gameModeOrdinal,
    mapPath,
    fogMode,
    startingCredits,
    revealedMap,
    aiDifficulty,
    currentUnitCap,
    maxUnitCap,
    startingUnits,
    incomeMultiplier,
    noNukes,
    sharedControl,
    teamLock,
    fixedAllyTeams,
    roomLock,
    allowSpectators,
    hasCustomUnits,
  };
}
