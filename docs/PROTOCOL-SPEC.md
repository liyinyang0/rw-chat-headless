# Rusted Warfare 网络协议线格式规格（字节级）

> 来源：RWX 源码（`core/src/main/java/com/corrodinggames/rts/gameFramework/network/`）逆向提取，
> 并经真实服务器联调验证（2026-09）。本文件是 rw-chat-headless 实现的规格依据。

## 1. 传输与帧

TCP（大端）。帧 = `[i32 payloadLen][i32 packetType][payload]`。
类型 >100 为握手/系统包（立即处理），≤100 为游戏包。

## 2. 基础类型（Java DataOutput 语义）

| 类型 | 格式 |
|---|---|
| UTF 串 | `u16 字节长度` + **modified UTF-8**（U+0000→C0 80；>U+FFFF→代理对 6 字节） |
| nullable 串 | 1 字节存在标志 + UTF（null 与空串可区分） |
| nullable int | 1 字节标志 + i32 |
| int/long/float | 大端 i32/i64/f32 |
| boolean | 1 字节 0/1 |

## 3. StreamBlock

`[UTF 块名][i32 数据长度][数据]`。数据是否 gzip 由上下文约定（115 的 "teams" 块
在 streamVersion≥141 时 gzip）。跳块 = 读名 + 读长 + skip。

## 4. 握手

```
C→S 160: UTF magic"com.corrodinggames.rts", i32 4, i32 netVer, i32 platform(2=PC),
         nullable UTF queryString, UTF playerName, UTF language, UTF flags""
S→C 161: UTF magic, i32 2, i32 netVer(★回显), i32 verCode, UTF pkg, UTF serverUuid,
         i32 sessionRandomId, i32 integritySalt, i32 0
C→S 110: UTF magic, i32 5, i32 netVer(=161回显), i32 176, UTF name,
         nullable UTF sha256(密码), UTF label, UTF clientId, i32 unitsChecksum,
         UTF g(sessionRandomId), UTF hex(integritySalt)
S→C 115: 团队列表（见 §6）→ 进入战役室
S→C 106: 房间设置（customUnits 块跳过即可，服务器不索要回执）
```

- **g() 完整性公式**：纯算术拼接（Java int 溢出 + Double.toString 科学计数），
  `d:` 段恒为 `5*seed`（源码中判断式两侧为同一表达式）。
- **unitsChecksum**：核心单位哈希常数，随版本不同。Rukkit/RW-HPS 不校验（0 可过）；
  真 RW/RWX 服务器校验（用 `tools/capture-server.ts` 从真客户端提取）。
- 161 在 110 之前到达 → 版本号回显即可跨版本。
- 老服务器（v151 官方 Auto Server）不认 i2 精简格式且强制校验 checksum。

## 5. 聊天

```
C→S 140: UTF 消息, byte 0
S→C 141: UTF 消息, byte 格式版本(服务器写 3), nullable UTF 发送者名,
         i32 发送者 connectionId, [版本≥3] i32 发送者 teamId
```

## 6. 115 团队列表（streamVersion≥141）

```
i32 yourTeamId, bool fullUpdate, i32 count(10),
block "teams" (gzip):
  count × { bool exists, i32 type(0玩家/1AI),
    [fullUpdate? 精简 : 完整状态] }
完整状态: byte teamId, i32 credits, i32 colorId, nullable UTF name, bool observer,
  i32 netId, i64 lastPing, bool spectator, i32 ping, i32 sortIdx, byte 0,
  bool connActive, bool netActive, bool victory, bool surrender, i32 surrenderMs,
  nullable UTF aiHint, i32 hostFlag, 4×nullable i32, i32 assignedColor
块外: i32 fog, i32 credits, bool revealed, i32 aiDiff, byte ver(5),
  i32 unitCap, i32 maxUnitCap, i32 startUnits, f32 income, bool noNukes, bool j,
  bool hasCustomUnits(→跳块), bool sharedControl, bool gamePaused
```

## 7. 保活与状态

```
C→S 108: i64 时间戳ms, byte 0        （每 ~2s；服务器 readTimeout 15s）
S→C 108: 同上 → 客户端回 109: i64 回显, byte 1, byte fps(≤130)
C→S 112: bool 未加载, bool isLoading （进房后发 false,false 报告已加载）
```

## 8. 密码与踢出

```
S→C 113: i32 0（需要/错误密码）→ 客户端 110 重发带 sha256(密码)
S→C 117: byte 0, i32 requestId, UTF prompt（官方中继用于问房间 id！）
C→S 118: byte 1, i32 requestId, UTF 明文应答
S→C 150: UTF 踢出原因
双向 111: UTF 断开原因
```

## 9. 151 PoW 挑战（中继/原版服务器）

```
S→C 151: i32 id, i32 type, [bool+int minClient], [bool+int minServer],
         [type 5/6: UTF 目标hash, UTF 基串, i32 最大迭代]
C→S 152: i32 id, i32 type, UTF 应答, f32 耗时
```

type 0/1=回显 int；2=g()；3/4=`hash14(minC+"|"+minS)`；5/6=暴力找 `i` 使
`hash14(base+i)==目标`；7=字符串重复。
**hash14 格式（RW-HPS 侧）**：`BigInteger(sha256).toString(16)`（去前导零）
→大写→截 14。注意与 RW 客户端的 `%064X` 补零格式在前导零时不同，以服务器侧为准。
实测官方 relay（Relay ASIA2/US2）在 160 后立即发 type 5（off∈0-10，秒解）。

## 10. 主服务器 HTTP（gs1/gs4 `/masterserver/1.4/interface`）

- `GET ?action=list&game_version=176&game_version_beta=false`，UA `rw pc 176 en`。
  首行含 `CORRODINGGAMES`；每行一房，CSV 22 列（[3]host [5]port [7]房主 [8]密码
  [9]地图 [11]状态 [12]版本串 [15/16]人数 [18]serverId [21]版本号→连接码）。
- `POST action=get&game_id=…&c=code(&p_hash=…)`: 行3 含 `sha256ShortHash("game_"+code)`，
  行5 CSV `[3]=host [5]=port`。code=md5 截断（高段位内嵌 g()）。
- 连接描述符：`gameVersionNumber==0` → `host:port`；否则 `get|serverId|verNum|pwd|port`。

## 11. 房间代码 → 中继

输入无 `.` `:` `/` 且长度>4 → 连接 `<首字母>.relay.corrodinggames.com`，
160 的 queryString=完整代码。

## 12. 实测兼容性矩阵（2026-09-05，全部真机验证）

| 服务器类型 | 版本 | 结果 |
|---|---|---|
| Rukkit（中文社区排位/生存服主力） | v176 | ✅ 进房+聊天+稳定在线 |
| RW-HPS（RKZ 等中继） | v151+ | ✅ PoW(type0-5) 通过 |
| **原版 RW r 码房（RELAY-CN 三跳中继）** | v176 | ✅ **全链路进房+聊天（r73580 实证）** |
| 官方 Auto Server | v151 | ❌ 强制校验 v151 专属 checksum（暂不支持） |

## 13. r 码三跳中继流程（RELAY-CN 实测，2026-09-05）

```
① 连 <首字母>.relay.corrodinggames.com:5123，160 带 query=房间码
   → 161（中继构造，uuid="RELAY-CN Team & Copyright dr@der.kim"）
   → 110 注册（format=5）→ 151 PoW（随机 type 0-5）→ 152 应答
   ⚠️ PoW 后【不要】重发 110 —— 节点会将重发行为判定为异常拒绝
② → 178 RECONNECT_TO（"[TCP]host:port"）→ 断开，重连节点（query 不带！）
   → 161 → 110 → 151 → 152 → 中继系统公告（141）
③ → 第三跳 161（真游戏房，netVer=176，salt=W 固定、seed 每连接随机）
   → 110 format=5（checksum=678359601 + g() + h()）→ 115/106 → 战役室
   房间不存在时：入口直接 117 应答链，报"[ xxxxx ] 我们找不到这个服务器"
```

## 14. 关键公式勘误（与真实原版客户端抓包逐字对比得出）

RWX 仓库是反编译重建版，与原版 RW 存在两处协议细节差异（本客户端默认按原版）：

1. **g() 的 `7:` 字段**：原版 = `e(7)*18*i`（乘法）；RWX 重建版误写为 `(e(7)*18)+i`。
   连 RWX 引擎服务器时设 `INTEGRITY_RWX_VARIANT=1` 切回加法版。
2. **h(i)** = `String.format("#%06X", i & 0xFFFFFF)`（`#` 前缀+补零 6 位+大写），
   不是 `Integer.toHexString`。应答错会被归入 noExtraChecks → 空理由踢出。
3. **176 核心单位校验和 = 678359601**（0x286EF231，从真实 RWX 客户端抓取，
   已内置为默认值；其他版本用 `tools/capture-server.ts` 提取）。

## 15. 开局应答（2026-09-11 透明代理抓包，RCN/IronCore 节点实测）

真客户端收到 120 开局包后的完整动作：

1. 立即回 **112，载荷 `00 01`**。第二字节必须为 01：发 `00 00` 服务器不认，
   会每 3 秒点名 "Still waiting on: …"，约 12 秒后超时带起强开。
2. 照常应答 109 心跳（每 2 秒）。
3. 每 ~10 秒发 type=31（290 字节）对局同步包。无头客户端不发此包也能在对局中
   存活（实测 2 分钟+，连接与聊天均正常），暂无需模拟。

无头客户端实现（session.ts）：收到 120/122 → 回 112(00 01)；系统聊天出现
"Still waiting on <自己名字>" 时再补发一次（点名即触发，自愈首次应答过早被
忽略的时机问题）。另注：真客户端进战役室时**不发** 112。
