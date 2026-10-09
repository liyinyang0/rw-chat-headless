# 名册、房间状态与连接生命周期修复

2026-10-09，分支 `codex/vanilla-room-join`。修复依据是 rw_analysis 两份原始反编译的发送/接收函数，不以可读重建版的字段名作为协议证据。研究与修复前复现见 [ROSTER-STATE-AUDIT.md](ROSTER-STATE-AUDIT.md)。密码功能本轮没有增加。

## 名册与房间状态

- 115 完整、精简模式都按本包存在的槽位生成名单；已删除的玩家和 count 缩小后的槽位不会残留。精简包保留字节不再误读为槽位。
- `pingMs` 读取真正的 ping 字段；`aiDifficulty` 独立记录 AI 难度。观战来自联盟 -3，AI 来自外层队伍类型。
- `sharedControlManual`、`sharedControlAutomatic` 分别保留两个共享控制字段，不再作为网络在线标志。
- `connectionActive` 为兼容旧调用方保留，含义改为服务端报告 ping>=0 或 HOST(-99)。-1 过期、-2 未知，不等于严格的玩家 TCP 状态。多房快照断线后人数为 0，名册本身可供离线回看。
- `isHost` 来自原版 hostFlag==1；保留 `hostFlag` 原值。社区服务器是否沿用原版标志仍须真实包核对。
- 115 设置补充 `sharedControl`、`gamePaused`，106 与 115 合并到 `settings`，每次收到有效设置通知 `settingsChange`。旧版本未提供字段不会覆盖为 false。
- 120 解析 skirmish/custom/save 地图类型、路径、内容字节数与可选 lateJoin；只跳过内容，不加载游戏资源。`gameStartInfo` 与 `gameStart` 事件提供本轮启动信息。处于 `in_game` 时地图优先取 `gameStartInfo?.mapPath`，大厅取 `roomInfo?.mapPath`。
- `phase` 仍为 lobby/in_game；暂停是独立设置。精简 115 可辅助推断 in_game；完整 115 不强行切回大厅。
- 116 true 将 `serverEnded` 置为 true 并通知 `gameEnded`；122 回大厅，同一轮结束只通知一次。新开局重新计数。`serverEnded` 保留到下一轮开局或新连接。

## 超时与重连

| 参数 | 默认值 | 行为 |
|---|---|---|
| JOIN_TIMEOUT_MS | 45000 | 每次 start 的入房预算，包含所有中继跳转；服务器要求输入时暂停 |
| RECEIVE_TIMEOUT_MS | 60000 | 入房后多久没收到完整协议帧判为失联 |
| AUTO_RECONNECT | 0 | CLI 和多房模式显式设为 1 才自动重试 |
| RECONNECT_MAX_RETRIES | 10 | 一次启动总重试次数，入房成功不重置，防止短连接循环 |
| RECONNECT_BASE_MS | 5000 | 指数退避初值 |
| RECONNECT_MAX_MS | 60000 | 退避等待上限，包含抖动 |

两个 Session 超时设为 0 可禁用。输入沿用独立 60 秒等待；不因公告、心跳挑战重置入房预算。不要求收到 109，不按最后聊天时间判断；任何完整协议帧都算接收活动，零碎字节不算。每次重新 start、已入房后的 178 跳转都重新获得入房预算；入房前的连续跳转共享总预算。

TCP/SOCKS 原有建连 7 秒超时保留；现在取消未完成的连接也会让 connect() 结束，不留悬空 Promise。超时和断线清理心跳、输入和检测定时器，旧连接和迟到异步结果不会干扰新连接。多房启动等待超时会真正断开该会话。

`Session` 检测并报告断线，不自行启动重试。CNKD Worker 已有自己的策略，继续直接使用 Session；本轮没有更改或部署 CNKD Worker。独立程序可以明确启用：

```ts
import { ReconnectingSession } from "../src/client/reconnecting.ts";

const session = new ReconnectingSession("r12345", {
  playerName: "bot", joinTimeoutMs: 45000, receiveTimeoutMs: 60000,
}, { enabled: true, maxRetries: 10 });
session.on("chat", chat => console.log(chat));
await session.start();
// 主动停止同时取消等待中的重试和迟到的地址解析。
session.disconnect();
```

每次重试从原始目标重新解析，沿用同一基础 clientUuid 和 SOCKS 出口，各中继跳仍按该跳 serverUuid 派生身份。默认 5/10/20/40/60 秒并带约 10% 抖动，最大不超过 60 秒。被踢、房间不存在、明确密码/版本/协议错误、服务端结束后断开都停止；用户退出取消后续重试。此模式重新入房并恢复聊天，不恢复游戏模拟或承诺保留原槽位。

## 验证

测试先按原版写侧独立构造协议包，复现错误后修复；覆盖完整→精简→槽位删除、AI/观战/房主、暂停与旧版本设置、三种地图、116/122 去重、入房总预算、失联与正常心跳、旧连接隔离、输入暂停、重启、重试预算及取消。

本机真实 TCP CLI 集成测试验证首连接断开→重新入房、/quit 停止重试、协商期间 stdin 关闭可正常退出。真实房间复查结果另存 [ROSTER-STATE-LIVE.json](ROSTER-STATE-LIVE.json)；统一入房的双客户端聊天验收见 [VANILLA-ROOM-JOIN.md](VANILLA-ROOM-JOIN.md)。公开房间的真实开局、暂停、服务端结束、实际网络断流仍需受控游戏场景验收，构造包和本机 TCP 测试不代替这些结论。

最终全量 16 个测试文件、151 项通过，`npm run typecheck` 通过。覆盖率范围是 package.json 显式列出的本轮协议与客户端模块（不含 CLI、工具和整个项目其他模块）：行/语句 91.65%、分支 80.17%、函数 90.72%。

实时复查记录：

- 用户房间 rkc595 已关闭，中继返回“你输入的房号是K595 房间不存在”。当时旧识别规则未覆盖这条文案，最终由入房超时结束；随后按该原始文案新增失败测试并修复为立即 room not found，不再应答或重试。保留上述 JSON 为修复前观察，未重复连接已关闭房间。
- 第一个列表候选房在连接时返回“A game as already been started on this server”，客户端按踢出退出。列表与实际可入房状态可能存在时间差，见 [初次列表实测](ROSTER-STATE-PUBLIC-LIVE.json)。
- 2026-10-09 19:57（UTC+8）重新拉取列表，选择空闲 `Auto Server 2+ [US-F #3]`。两个客户端入房、B 发送唯一标记且 A 收到回显；完整名册为槽位 0/1、名字 A/B、ping 222/219ms、两个共享控制标志均 false、在线人数 2；设置 sharedControl=false、gamePaused=false、phase=lobby。两个客户端完成后主动退出。见 [完整实测记录](ROSTER-STATE-PUBLIC-LIVE-RECHECK.json)。未验证社区 hostFlag 或 AI/观战玩家的真实切换。
