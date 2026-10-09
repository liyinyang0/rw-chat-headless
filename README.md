# rw-chat-headless — 仅聊天的无头 Rusted Warfare 客户端

[中文](README.md) | [English](README.en.md) | [Русский](README.ru.md)

以玩家身份进入兼容 **TCP / 176 协议**的 Rusted Warfare 房间（公开列表 / 房间代码 / IP 直连），在战役室收发聊天，并实现开局后的聊天连接保活。
**仅聊天**：不当房主、不参与对局操作，纯"挂房间里说话/收消息"的无头实例。
纯 TypeScript / Node 22+ 协议实现：无游戏引擎、无 UI、无图形依赖。

本仓库只提供"客户端本体"。要接 AI / 自动回复 / 桥接外部服务，见下文[编程接入](#编程接入自己接agent)——
你自己的机器人逻辑自己写，客户端把 `chat` 事件和 `sendChat()` 留给你。

## 能力

- ✅ 公开列表选房进入（`list` → `list:N`）
- ✅ 房间代码进入：自动应答中继 PoW，处理 178 跳转与后续游戏房握手；跳转次数由实际路由决定，部分握手复用同一 TCP 连接
- ✅ IP / 域名直连
- ✅ 支持跳过服务器推送的 customUnits 块进行聊天，无需安装对应 mod；额外认证或修改协议的 mod 服务器需另行验证
- ✅ 密码应答（`PASSWORD` / 输入接口）与中继 PoW；当前证据范围见下文说明
- ✅ 战役室聊天收发（141 收 / 140 发）、玩家名册（115）
- ✅ 名册槽位删除、观战/AI、ping、共享控制；房间暂停、开局地图与结束通知
- ✅ 入房截止时间与接收失联检测；独立 CLI / 多房可选退避重连
- ✅ 单进程多房间（每房一条连接，独立会话与聊天记录）
- ✅ 176 核心单位校验和已内置（678359601，从真实客户端抓取）
- ✅ 开局(120)时回 112 报告加载状态，默认保留连接；不执行游戏模拟，不能保证所有服务器正常开局或长期允许留在对局
- ❌ 不当房主、不参与对局操作；未实现可靠 UDP，也未提供其他协议版本的完整适配（包括 v151 官方 Auto Server）

> 协议字节级规格见 [docs/PROTOCOL-SPEC.md](docs/PROTOCOL-SPEC.md)。
> g() 公式 `7:` 字段统一使用原版乘法；h() 为 `#%06X` 格式。
> 入房实现按 TCP / 176 协议统一处理代码、列表描述符、地址和中继跳转，不按服务器品牌切换。
> 2026-10-09 已验证公开列表房间和用户房间 `rkc595` 的双客户端聊天回显；UDP、其他版本和所有社区扩展尚未全面验证。改动与证据见 [统一入房说明](docs/VANILLA-ROOM-JOIN.md)。
> 后续名册、状态和失联修复见 [修复说明](docs/ROSTER-STATE-FIX.md)。
> 密码流程、观战/AI 解析、暂停与开局状态已有构造包和本机 TCP 测试；本轮没有真实密码房验收，真实观战切换、开局、暂停及长期在线仍需受控房间验证。公开列表状态可能滞后，列表显示大厅也可能被实际服务器拒绝入房。

## 快速开始

需要 Node.js 22 或更新版本。Linux / macOS：

```bash
npm install
cp .env.example .env        # 按需改 NAME 等

node --env-file=.env --import tsx src/cli.ts list
node --env-file=.env --import tsx src/cli.ts join list:0
```

Windows PowerShell：

```powershell
npm install
Copy-Item .env.example .env  # 按需编辑 .env
node --env-file=.env --import tsx src/cli.ts list
node --env-file=.env --import tsx src/cli.ts join list:0
```

CLI 读取进程环境变量，`--env-file=.env` 显式加载配置；已有环境变量优先于文件里的同名值。不使用配置文件时可运行 `npx tsx src/cli.ts ...`，它不会自动加载 `.env`。单房模式输入文字聊天，`/quit` 退出；stdin 关闭也会退出。

target 形式：`list:N` / 房间代码（如 `rkzxxxx`）/ `1.2.3.4:5123` / `get|id|code|pwd|port` 完整描述符。列表序号从 0 开始，每次重新拉取可能变化；shell 中输入完整描述符时加引号，避免 `|` 被当成管道。

## 单进程多房间

一个进程同时进多个房（协议上一条连接只能在一个战役室，多房 = 多条连接）：

```bash
node --env-file=.env --import tsx src/cli.ts join-multi list:0 list:2 list:5
```

- 每会话的基础 UUID 自动加 `-m1/-m2/…` 区分，再与每跳 serverUuid 派生身份
- 玩家名默认第 2 个会话起加后缀（name、name-2…），减少重名冲突；`MULTI_NAME=same` 关闭。服务器仍可能自动改名或拒绝重名
- 会话错峰启动（`MULTI_STAGGER_MS`，默认 1200）；单房失败不影响其余
- stdin 命令：`/rooms`（状态表）、`/say <序号> <文本>`、`/sayall <文本>`、`/quit`；这里房间序号从 1 开始，区别于公开列表的 `list:N`
- `/rooms` 的 `roomId` 是历史命名，实际显示 serverUuid，不是输入的房间号，也不保证唯一；请结合目标标签和名册核对房间
- `MULTI_LIFETIME_MS=60000`：到时自动退出（无人值守测试用）
- 每房最近 200 条聊天保留在内存（`handle.history()`）
- 多房 CLI 的 stdin 关闭后继续运行；`/quit`、SIGINT/SIGTERM 或生命周期截止时间退出。目标参数也支持逗号分隔
- 历史测量约为单实例 40MB、多房进程基线 70MB、每额外房间约 +1MB，缺少完整测试条件，仅供量级参考。实际取决于 Node 版本、平台和流量；游戏包仍需接收和组帧，大地图/存档可能造成瞬时内存增长。以启动日志的 RSS/heap 和实际运行测量为准

## 编程接入（自己接agent）

CLI 之外，`Session` 是可直接使用的库。聊天进来了是 `chat` 事件，说话用 `sendChat()`——
接 LLM、规则引擎、消息桥，都从这个口子进：

```ts
import { Session } from "./src/client/session.ts";
import { parseConnectTarget, resolveTarget } from "./src/masterserver/target.ts";

const target = await resolveTarget(parseConnectTarget("1.2.3.4:5123"), null);
const session = new Session(target, { playerName: "my-bot" });

session.on("chat", (chat) => {
  if (!chat.senderName) return; // 跳过系统消息
  // 缺少槽位信息时不自动回复，避免无法识别自己的回显。
  if (chat.senderTeamId === null || chat.senderTeamId < 0 || session.yourTeamId < 0) return;
  if (chat.senderTeamId === session.yourTeamId) return;
  // ↓ 这里写你自己的逻辑：调 LLM、查规则、转发到别的平台……
  session.sendChat(`echo: ${chat.message}`);
});

session.on("stateChange", (s) => console.log("state:", s));
await session.start();
```

`senderTeamId` 与 `yourTeamId` 是当前连接的玩家槽位，不是昵称或联盟编号。结盟版客户端可能给显示名加前缀；服务器也可能因重名等原因修改昵称，所以不要靠固定昵称或去掉数字前缀识别自己。较老聊天格式缺少发送者槽位，上例会跳过自动回复；需要另行验证可靠身份映射后再启用。

`session.roster` 是当前名册（含 AI / 观战 / ping / 共享控制）。`connectionActive` 从服务端 ping 派生“最近在线”，不代表实时 TCP 状态。`session.info.serverUuid` 是服务器下发的身份字段；共享中继可能在多个房间复用，不能单独用它确认目标房间。
多房间编排用 `runMultiRooms()`（见 `src/client/multi.ts`），每房一个 handle。

服务器要求密码或其他输入时，可监听 `inputRequest`，再调用 `request.respond(answer)`；`null` 取消连接。也可在 `SessionOptions.onInputRequest` 中返回应答。单房 CLI 将下一行作为应答；无法判断含义的 117 提示会等待输入，默认 60 秒超时。公开列表密码房在地址解析前需要 `PASSWORD`。

多房编程接口可传 `onInputRequest`；多房 CLI 没有按房间回答任意输入的命令。

同一个 `session` 还可监听状态事件（在 `start()` 前注册）：

```ts
session.on("settingsChange", settings => console.log("paused:", settings.gamePaused));
session.on("phaseChange", phase => console.log("phase:", phase));
session.on("gameStart", start => console.log("map:", start.mapType, start.mapPath));
session.on("gameEnded", () => console.log("round ended"));
```

连接 `state` 与对局 `phase` 独立；暂停不等于回大厅。`gameEnded` 来自服务端结束通知或游戏后回大厅，同一轮去重，不表示 TCP 已断开。游戏中优先取 `gameStartInfo?.mapPath`，大厅取 `roomInfo?.mapPath`；尚未收到相关信息时字段可能为空。

独立程序需要自动重连时，可以把上面的构造过程改为：

```ts
import { ReconnectingSession } from "./src/client/reconnecting.ts";

const session = new ReconnectingSession("rkzxxxx", { playerName: "my-bot" }, {
  enabled: true, maxRetries: 10,
});
// 沿用上面的事件监听，随后 await session.start()。
// 主动退出：session.disconnect()，同时取消后续重试。
```

普通 `Session` 仅检测断线，不自动重试；已有外部 Worker 管理重试时继续使用它，避免重复重连。重新入房恢复聊天，不恢复游戏模拟，也不保证原槽位不变。

## 核心单位校验和（UNITS_CHECKSUM）

176 版常数 678359601 已内置为默认值。自定义校验和可通过抓包提取；其他版本还可能需要相应包结构，不能仅靠替换常数保证兼容：

```bash
npx tsx tools/capture-server.ts 5123     # 监听 127.0.0.1:5123（会自动回合成 161）
# 真实客户端 → 多人 → 直接加入 → 127.0.0.1:5123
# 控制台打印 ★ 校验和 / g() 公式对比 / h() 格式
# 在 .env 中填写捕获到的 UNITS_CHECKSUM，再用上面的 --env-file 命令进房。
```

## 环境变量

见 [.env.example](.env.example)：`NAME` / `PASSWORD` / `LANGUAGE` / `REGISTER_FORMAT` /
`UNITS_CHECKSUM` / `RELAY_ROOM_ID` / `CLIENT_UUID` / `RW_SOCKS_PROXY` / `DEBUG`，以及连接与重连参数。

Session 默认入房预算 45 秒（包含中继跳转），入房后 60 秒没有完整协议帧则断开；分别通过 `JOIN_TIMEOUT_MS`、`RECEIVE_TIMEOUT_MS` 调整，0 禁用对应会话定时器。等待服务器要求的输入时暂停入房预算，使用独立输入超时。聊天安静、没有收到客户端 108 的 109 回包都不单独判为失联。

多房 runner 另有默认 45 秒启动结算等待，超时会关闭未入房会话；单独将 `JOIN_TIMEOUT_MS` 设为 0 或更大不会关闭或延长这层等待。编程接口可通过 `settleTimeoutMs` 调整。

独立 CLI / 多房模式设置 `AUTO_RECONNECT=1` 开启重连。默认最多重试 10 次，按 5/10/20/40/60 秒退避并抖动，每次从原始房间代码重新解析，沿用身份和代理；被踢、房间不存在、主动退出停止。库使用 `ReconnectingSession` 明确启用；已有外部 Worker 负责重试时继续使用 `Session`。详情及事件接口见 [修复说明](docs/ROSTER-STATE-FIX.md)。

配置默认值：`AUTO_RECONNECT=0`、`RECONNECT_MAX_RETRIES=10`、`RECONNECT_BASE_MS=5000`、`RECONNECT_MAX_MS=60000`。等待包含抖动也不超过上限；成功入房不重置一次启动的总重试预算。

## 客户端身份（每部署一份，默认持久）

客户端对服务器的身份（clientId）由一个客户端 UUID 派生：`SHA256(uuid + 每跳 serverUuid)`（固定 64 位大写），
模拟真实客户端逐跳派生。这个 UUID 的默认行为：

- **首次运行自动生成随机值**，持久化在 `data/client-uuid`——每个部署一份、互不相同，
  跨进程重启保持同一身份（断线重连同身份、服务器侧识别都依赖它）
- 想换身份：删掉 `data/client-uuid` 后重新启动进程，或设置环境变量 `CLIENT_UUID` 显式覆盖
- 容器 / CI 等无持久磁盘的场景：请显式设置 `CLIENT_UUID`，否则每次容器重建都是新身份
- `data/` 已在 `.gitignore` 里，身份文件不会被误提交

默认持久身份需要 `data/` 可写；只读环境会退化为仅本次进程有效的随机值。多个部署应各用独立数据目录或显式 UUID。

多房间模式下所有会话共享同一基础 UUID，仅加 `-m1/-m2/…` 槽位后缀区分。
本次修复将旧版小写身份哈希改为原版大写格式，即使基础 UUID 不变，服务端也可能将其识别为新身份。

## 工具（tools/）

- `capture-server.ts` — 假服务器抓真实客户端的注册指纹/校验和
- `proxy-capture.ts` — 中间人代理抓包
- `probe.ts` — 快速探测目标服务器行为
- `GoldenG.java` / `golden-g.txt` — g() 公式参考实现与测试向量
- `dump-descriptors.mjs` — 打印包描述符

## 使用礼仪

这个客户端进入的是**别人维护的服务器**。请遵守：

- 服务器可能限制连接频率和聊天频率，具体阈值由服务端决定；重连保留退避，自动回复自行限速
- 明示机器人身份（起个一眼能认出的名字），别伪装真人
- 房主没同意就别赖在人家房里；被踢就退
- 已输入的房间码会用于明确的 117 房间号提示；直连中继时可配 `RELAY_ROOM_ID`（`new` 开新房要当房主，本项目不支持）

## 开发

```bash
npm test              # 协议、会话、多房与生命周期测试
npm run typecheck     # tsc --noEmit
npm run test:coverage # 本轮修改的协议模块覆盖率
```

## License

AGPL-3.0-only（GNU Affero General Public License，仅第 3 版），见 [LICENSE](LICENSE)。
