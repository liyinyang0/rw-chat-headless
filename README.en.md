# rw-chat-headless — Headless chat-only Rusted Warfare battleroom client

[中文](README.md) | [English](README.en.md) | [Русский](README.ru.md)

Join **any** Rusted Warfare server as a player (public list / room code / direct IP) and sit in the battleroom sending and receiving chat.
**Chat only**: never hosts, never performs in-game actions — a headless instance that just sits in the room and talks/listens.
Pure TypeScript / Node 22 protocol implementation: no game engine, no UI, no graphics dependencies, ~40MB per instance.

This repo ships only the client itself. To hook up an AI / auto-reply / external bridge, see
[Programmatic access](#programmatic-access-bring-your-own-bot) below —
you write your own bot logic; the client hands you the `chat` event and `sendChat()`.

## Capabilities

- ✅ Join from the public server list (`list` → `list:N`)
- ✅ Join via room code (full r-code three-hop relay chain): entry PoW → 178 redirect → node → real game room; join + chat
- ✅ Direct IP / domain connection
- ✅ Joins modded rooms directly (customUnits blocks pushed by the server are simply skipped — no mods needed)
- ✅ Password rooms (`PASSWORD`); Rukkit / RW-HPS / official relay (PoW auto-answered)
- ✅ Battleroom chat send/receive (141 recv / 140 send), player roster (115)
- ✅ Multiple rooms in one process (one connection per room, independent sessions and chat history)
- ✅ v176 core units checksum built in (678359601, captured from a real client)
- ❌ Never hosts, never performs in-game actions; on game start (120) replies 112 "entered the game" so the whole room can start, and stays in the room to keep chatting
- ❌ v151 official Auto Server (version-specific checksum, no constant available yet)

> Byte-level protocol spec: [docs/PROTOCOL-SPEC.md](docs/PROTOCOL-SPEC.md).
> The g() formula always uses vanilla multiplication for `7:`; h() uses `#%06X`.
> Room codes, list descriptors, addresses and binary relay redirects share one TCP / 176 join flow. Public-list and `rkc595` two-client chat checks passed on 2026-10-09; UDP, other versions and community extensions are not fully verified. See [join changes and evidence](docs/VANILLA-ROOM-JOIN.md).

## Quick start

```bash
npm install
cp .env.example .env        # adjust NAME etc. as needed

npx tsx src/cli.ts list                     # fetch the public room list
NAME=test-bot npx tsx src/cli.ts join list:34   # join a room, chat manually from the terminal
```

Target forms: `list:N` / room code (e.g. `rkzxxxx`) / `1.2.3.4:5123` / full `get|id|code|pwd|port` descriptor.

## Multi-room in one process

One process in several rooms at once (protocol-wise a connection lives in exactly one battleroom; more rooms = more connections):

```bash
npx tsx src/cli.ts join-multi list:0 list:2 list:5   # comma-separated also works
```

- Each session gets its own clientId (derived from serverUuid by default, which would collide — a `-m1/-m2/…` suffix is added automatically)
- Player names get a suffix from the 2nd session on (name, name-2, …) to avoid same-name mutual kicks on one server; disable with `MULTI_NAME=same`
- Sessions start staggered (`MULTI_STAGGER_MS`, default 1200); one room failing doesn't affect the others
- stdin commands: `/rooms` (status table), `/say <index> <text>`, `/sayall <text>`, `/quit`
- `MULTI_LIFETIME_MS=60000`: auto-exit after the deadline (for unattended tests)
- Last 200 chat messages per room kept in memory (`handle.history()`)
- Memory footprint: ~70MB process baseline, ~+1MB per extra room (game streams are discarded; memory doesn't grow with battle traffic)

## Programmatic access (bring your own bot)

Beyond the CLI, `Session` is a directly usable library. Incoming chat is the `chat` event; speaking is `sendChat()` —
LLMs, rule engines, message bridges all plug in here:

```ts
import { Session } from "./src/client/session.ts";
import { parseConnectTarget, resolveTarget } from "./src/masterserver/target.ts";

const target = await resolveTarget(parseConnectTarget("1.2.3.4:5123"), null);
const session = new Session(target, { playerName: "my-bot" });

session.on("chat", (chat) => {
  if (!chat.senderName || chat.senderName === "my-bot") return; // skip system messages and own echo
  // ↓ your own logic here: call an LLM, match rules, forward to another platform…
  session.sendChat(`echo: ${chat.message}`);
});

session.on("stateChange", (s) => console.log("state:", s));
await session.start();
```

`session.roster` is the current roster (with AI / disconnected / spectator flags). `session.info.serverUuid` is a server identity field; shared relays can reuse it across rooms, so it cannot alone identify a room.
For multi-room orchestration use `runMultiRooms()` (see `src/client/multi.ts`), one handle per room.

## Units checksum (UNITS_CHECKSUM)

The v176 constant 678359601 is built in as the default. If another version gets rejected by the checksum check, extract it once with the capture tool:

```bash
npx tsx tools/capture-server.ts 5123     # listens on 127.0.0.1:5123 (auto-replies 161 for the synthesis)
# real client → Multiplayer → Direct Join → 127.0.0.1:5123
# the console prints ★ checksum / g() formula comparison / h() format
UNITS_CHECKSUM=NNNN npx tsx src/cli.ts join <target>
```

## Environment variables

See [.env.example](.env.example): `NAME` / `PASSWORD` / `LANGUAGE` / `REGISTER_FORMAT` /
`UNITS_CHECKSUM` / `RELAY_ROOM_ID` / `CLIENT_UUID` / `RW_SOCKS_PROXY` / `DEBUG`.

## Client identity (one per deployment, persistent by default)

The client's identity toward a server (clientId) is derived from a client UUID: `sha256(uuid + per-hop serverUuid)`,
mimicking how the real client derives it hop by hop. Default behavior of this UUID:

- **Generated randomly on first run**, persisted in `data/client-uuid` — one per deployment, all different,
  stable across process restarts (reconnect with the same identity and server-side recognition both depend on it)
- To change identity: delete `data/client-uuid` (regenerated on next run), or set `CLIENT_UUID` to override explicitly
- Containers / CI without persistent disk: set `CLIENT_UUID` explicitly, otherwise every container rebuild is a new identity
- `data/` is already in `.gitignore`; the identity file won't be committed by accident

In multi-room mode all sessions share the same base UUID, distinguished only by the `-m1/-m2/…` slot suffix.

## Tools (tools/)

- `capture-server.ts` — fake server that captures a real client's registration fingerprint / checksum
- `proxy-capture.ts` — man-in-the-middle capture proxy
- `probe.ts` — quick behavior probe of a target server
- `GoldenG.java` / `golden-g.txt` — g() formula reference implementation and test vectors
- `dump-descriptors.mjs` — print packet descriptors

## Etiquette

This client joins **other people's servers**. Please:

- Servers rate-limit connections (5–30 unregistered connections from one IP get rejected): back off on reconnects, don't loop at high frequency
- Chat has anti-spam (message cap per 60 s): don't trigger auto-replies at high frequency
- Make the bot obvious (pick a recognizable name); don't pose as a human
- Don't squat in someone's room without the host's consent; leave when kicked
- The official relay asks for the room id via 117 after connecting: set `RELAY_ROOM_ID` (opening a new room with `new` means hosting, which this project doesn't support)

## Development

```bash
npm test              # protocol, session, multi-room and lifecycle tests
npm run typecheck     # tsc --noEmit
```

## License

AGPL-3.0-only (GNU Affero General Public License, version 3 only), see [LICENSE](LICENSE).
