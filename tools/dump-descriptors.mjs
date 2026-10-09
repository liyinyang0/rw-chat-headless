/**
 * 打印公开房间及其稳定 get| 描述符（join-multi 用描述符比 list:N 稳，
 * 列表序号在两次调用之间会漂移）。
 * 用法：npx tsx tools/dump-descriptors.mjs [状态过滤，默认 battleroom]
 */
import { listRooms, roomConnectDescriptor } from "../src/masterserver/client.ts";
const state = process.argv[2] ?? "battleroom";
const rooms = await listRooms();
rooms.forEach((r, i) => {
  if (r.gameState !== state) return;
  const flags = [r.requiresPassword ? "🔒" : "", r.hasMods ? "mod" : "", `v${r.gameVersionCode ?? "?"}`].join(" ");
  console.log(`#${i} | ${r.createdBy} | ${r.currentPlayers}/${r.maxPlayers} | ${r.gameState} ${flags} | ${roomConnectDescriptor(r)}`);
});
