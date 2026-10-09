# rw-chat-headless — 仅聊天的无头 Rusted Warfare 战役室客户端

[中文](README.md) | [English](README.en.md) | [Русский](README.ru.md)

以玩家身份进入**任意** Rusted Warfare 服务器（公开列表 / 房间代码 / IP 直连），停留在战役室收发聊天。
**仅聊天**：不当房主、不参与对局操作，纯"挂房间里说话/收消息"的无头实例。
纯 TypeScript / Node 22 协议实现：无游戏引擎、无 UI、无图形依赖，单实例内存 ~40MB。

本仓库只提供"客户端本体"。要接 AI / 自动回复 / 桥接外部服务，见下文[编程接入](#编程接入自己接机器人)——
你自己的机器人逻辑自己写，客户端把 `chat` 事件和 `sendChat()` 留给你。

## 能力

- ✅ 公开列表选房进入（`list` → `list:N`）
- ✅ 房间代码进入（r 码三跳中继全链路）：入口 PoW → 178 跳转 → 节点 → 真游戏房，进房 + 聊天
- ✅ IP / 域名直连
- ✅ mod 房直接进（服务器推送的 customUnits 块直接跳过，无需装 mod）
- ✅ 密码房（`PASSWORD`）、Rukkit / RW-HPS / 官方 relay（PoW 自动应答）
- ✅ 战役室聊天收发（141 收 / 140 发）、玩家名册（115）
- ✅ 单进程多房间（每房一条连接，独立会话与聊天记录）
- ✅ 176 核心单位校验和已内置（678359601，从真实客户端抓取）
- ❌ 不当房主、不参与对局操作；开局(120)时回 112 报"已进入对局"，不阻塞全房开局，留在房里保持聊天
- ❌ v151 官方 Auto Server（版本专属校验和，暂无常数）

> 协议字节级规格见 [docs/PROTOCOL-SPEC.md](docs/PROTOCOL-SPEC.md)。
> g() 公式 `7:` 字段原版为乘法（连 RWX 引擎服务器可设 `INTEGRITY_RWX_VARIANT=1`）；h() 为 `#%06X` 格式。

## 快速开始

```bash
npm install
cp .env.example .env        # 按需改 NAME 等

npx tsx src/cli.ts list                 # 拉取公开房间列表
NAME=测试 npx tsx src/cli.ts join list:34   # 进房，终端手动聊天
```

target 形式：`list:N` / 房间代码（如 `rkzxxxx`）/ `1.2.3.4:5123` / `get|id|code|pwd|port` 完整描述符。

## 单进程多房间

一个进程同时进多个房（协议上一条连接只能在一个战役室，多房 = 多条连接）：

```bash
npx tsx src/cli.ts join-multi list:0 list:2 list:5   # 也可逗号分隔
```

- 每会话独立 clientId（缺省按 serverUuid 派生会撞，自动加 `-m1/-m2/…` 区分）
- 玩家名默认第 2 个会话起加后缀（name、name-2…）防同服务器重名互踢；`MULTI_NAME=same` 关闭
- 会话错峰启动（`MULTI_STAGGER_MS`，默认 1200）；单房失败不影响其余
- stdin 命令：`/rooms`（状态表）、`/say <序号> <文本>`、`/sayall <文本>`、`/quit`
- `MULTI_LIFETIME_MS=60000`：到时自动退出（无人值守测试用）
- 每房最近 200 条聊天保留在内存（`handle.history()`）
- 内存量级：进程基线 ~70MB，每多一房约 +1MB（游戏流被丢弃，内存不随战斗流量涨）

## 编程接入（自己接机器人）

CLI 之外，`Session` 是可直接使用的库。聊天进来了是 `chat` 事件，说话用 `sendChat()`——
接 LLM、规则引擎、消息桥，都从这个口子进：

```ts
import { Session } from "./src/client/session.ts";
import { parseConnectTarget, resolveTarget } from "./src/masterserver/target.ts";

const target = await resolveTarget(parseConnectTarget("1.2.3.4:5123"), null);
const session = new Session(target, { playerName: "my-bot" });

session.on("chat", (chat) => {
  if (!chat.senderName || chat.senderName === "my-bot") return; // 跳过系统消息和自己的回显
  // ↓ 这里写你自己的逻辑：调 LLM、查规则、转发到别的平台……
  session.sendChat(`echo: ${chat.message}`);
});

session.on("stateChange", (s) => console.log("state:", s));
await session.start();
```

`session.roster` 是当前名册（含 AI / 掉线 / 观战标记），`session.info.serverUuid` 是房间稳定标识。
多房间编排用 `runMultiRooms()`（见 `src/client/multi.ts`），每房一个 handle。

## 核心单位校验和（UNITS_CHECKSUM）

176 版常数 678359601 已内置为默认值。其他版本如被校验拒绝，用抓包工具提取一次即可：

```bash
npx tsx tools/capture-server.ts 5123     # 监听 127.0.0.1:5123（会自动回合成 161）
# 真实客户端 → 多人 → 直接加入 → 127.0.0.1:5123
# 控制台打印 ★ 校验和 / g() 公式对比 / h() 格式
UNITS_CHECKSUM=NNNN npx tsx src/cli.ts join <target>
```

## 环境变量

见 [.env.example](.env.example)：`NAME` / `PASSWORD` / `LANGUAGE` / `REGISTER_FORMAT` /
`UNITS_CHECKSUM` / `RELAY_ROOM_ID` / `CLIENT_UUID` / `RW_SOCKS_PROXY` / `DEBUG`。

## 客户端身份（每部署一份，默认持久）

客户端对服务器的身份（clientId）由一个客户端 UUID 派生：`sha256(uuid + 每跳 serverUuid)`，
模拟真实客户端逐跳派生。这个 UUID 的默认行为：

- **首次运行自动生成随机值**，持久化在 `data/client-uuid`——每个部署一份、互不相同，
  跨进程重启保持同一身份（断线重连同身份、服务器侧识别都依赖它）
- 想换身份：删掉 `data/client-uuid`（下次运行重新生成），或设置环境变量 `CLIENT_UUID` 显式覆盖
- 容器 / CI 等无持久磁盘的场景：请显式设置 `CLIENT_UUID`，否则每次容器重建都是新身份
- `data/` 已在 `.gitignore` 里，身份文件不会被误提交

多房间模式下所有会话共享同一基础 UUID，仅加 `-m1/-m2/…` 槽位后缀区分。

## 工具（tools/）

- `capture-server.ts` — 假服务器抓真实客户端的注册指纹/校验和
- `proxy-capture.ts` — 中间人代理抓包
- `probe.ts` — 快速探测目标服务器行为
- `GoldenG.java` / `golden-g.txt` — g() 公式参考实现与测试向量
- `dump-descriptors.mjs` — 打印包描述符

## 使用礼仪

这个客户端进入的是**别人维护的服务器**。请遵守：

- 服务器有连接频率限制（同 IP 5–30 次未注册连接会被拒）：重连带退避，不要高频循环
- 聊天有反刷屏（60 秒条数上限）：自动回复勿高频触发
- 明示机器人身份（起个一眼能认出的名字），别伪装真人
- 房主没同意就别赖在人家房里；被踢就退
- 官方 relay 连上后 117 会问房间 id：配 `RELAY_ROOM_ID`（`new` 开新房要当房主，本项目不支持）

## 开发

```bash
npm test              # 协议、会话、多房与生命周期测试
npm run typecheck     # tsc --noEmit
```

## License

AGPL-3.0-only（GNU Affero General Public License，仅第 3 版），见 [LICENSE](LICENSE)。
