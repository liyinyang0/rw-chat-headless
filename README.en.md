# rw-chat-headless — Headless chat-only Rusted Warfare battleroom client

[中文](README.md) | [English](README.en.md) | [Русский](README.ru.md)

Join Rusted Warfare rooms compatible with **TCP / protocol 176** as a player (public list / room code / direct IP), exchange battleroom chat, and keep a chat connection after game start.
**Chat only**: never hosts, never performs in-game actions — a headless instance that just sits in the room and talks/listens.
Pure TypeScript / Node 22+ protocol implementation: no game engine, no UI, no graphics dependencies.

This repo ships only the client itself. To hook up an AI / auto-reply / external bridge, see
[Programmatic access](#programmatic-access-bring-your-own-bot) below —
you write your own bot logic; the client hands you the `chat` event and `sendChat()`.

## Capabilities

- ✅ Join from the public server list (`list` → `list:N`)
- ✅ Join via room code: answer relay PoW, follow 178 redirects, and complete the game-room handshake; the route determines the number of redirects, and some handshakes reuse one TCP connection
- ✅ Direct IP / domain connection
- ✅ Skip server customUnits blocks for chat without installing the mods; mod servers requiring extra authentication or altered protocols need separate verification
- ✅ Password responses (`PASSWORD` / input API) and relay PoW; see the verification scope below
- ✅ Battleroom chat send/receive (141 recv / 140 send), player roster (115)
- ✅ Roster slot deletion, spectators/AI, ping and shared control; pause, start-map information and game-end notifications
- ✅ Join deadlines and receive timeout detection; optional backoff reconnect for the CLI and multi-room runner
- ✅ Multiple rooms in one process (one connection per room, independent sessions and chat history)
- ✅ v176 core units checksum built in (678359601, captured from a real client)
- ✅ Reply with loading status 112 on game start (120), keeping the connection by default; no game simulation, so successful starts and long-term in-game connections are not guaranteed for every server
- ❌ No hosting or gameplay; reliable UDP and complete support for other protocol versions (including v151 official Auto Server) are not implemented

> Byte-level protocol spec: [docs/PROTOCOL-SPEC.md](docs/PROTOCOL-SPEC.md).
> The g() formula always uses vanilla multiplication for `7:`; h() uses `#%06X`.
> Room codes, list descriptors, addresses and binary relay redirects share one TCP / 176 join flow. Public-list and `rkc595` two-client chat checks passed on 2026-10-09; UDP, other versions and community extensions are not fully verified. See [join changes and evidence](docs/VANILLA-ROOM-JOIN.md).
> Roster, state and connection fixes: [details and evidence](docs/ROSTER-STATE-FIX.md). Password flows, spectator/AI parsing, pause and start states have synthetic-packet and local TCP tests. This round did not test a real password room; live spectator changes, starts, pauses and long-term connections still need controlled-room verification. Public listings may lag behind the actual server state and joining can be refused even when the list says battleroom.

## Quick start

Requires Node.js 22 or newer. Linux / macOS:

```bash
npm install
cp .env.example .env        # adjust NAME etc. as needed

node --env-file=.env --import tsx src/cli.ts list
node --env-file=.env --import tsx src/cli.ts join list:0
```

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env  # edit .env as needed
node --env-file=.env --import tsx src/cli.ts list
node --env-file=.env --import tsx src/cli.ts join list:0
```

The CLI reads process environment variables; `--env-file=.env` explicitly loads the configuration. Existing environment variables override matching file values. Without a config file, use `npx tsx src/cli.ts ...`, which does not automatically load `.env`. In single-room mode, type messages to chat and `/quit` to exit; closing stdin also exits.

Target forms: `list:N` / room code (e.g. `rkzxxxx`) / `1.2.3.4:5123` / full `get|id|code|pwd|port` descriptor. List indices start at 0 and may change on each fetch. Quote full descriptors in a shell so `|` is not interpreted as a pipe.

## Multi-room in one process

One process in several rooms at once (protocol-wise a connection lives in exactly one battleroom; more rooms = more connections):

```bash
node --env-file=.env --import tsx src/cli.ts join-multi list:0 list:2 list:5
```

- Each session's base UUID gets a `-m1/-m2/…` suffix, then its identity is derived using each hop's serverUuid
- Player names get a suffix from the 2nd session on (name, name-2, …) to reduce name conflicts; disable with `MULTI_NAME=same`. Servers can still rename players or reject duplicate names
- Sessions start staggered (`MULTI_STAGGER_MS`, default 1200); one room failing doesn't affect the others
- stdin commands: `/rooms` (status table), `/say <index> <text>`, `/sayall <text>`, `/quit`; room indices here start at 1, unlike the public-list `list:N` indices
- The historical `roomId` label in `/rooms` actually shows serverUuid, not the entered room code, and is not necessarily unique; also check the target label and roster
- `MULTI_LIFETIME_MS=60000`: auto-exit after the deadline (for unattended tests)
- Last 200 chat messages per room kept in memory (`handle.history()`)
- Closing stdin in multi-room mode keeps it running; exit with `/quit`, SIGINT/SIGTERM or the lifetime deadline. Target arguments can also be comma-separated
- Historical memory estimates: about 40MB for one instance, 70MB multi-room process baseline, and +1MB per additional room. Full measurement conditions are unavailable, so these are scale estimates. Actual usage depends on Node version, platform and traffic; game frames must still be received and assembled, and large maps/saves can cause temporary increases. Measure RSS/heap from the startup log and during actual operation

## Programmatic access (bring your own bot)

Beyond the CLI, `Session` is a directly usable library. Incoming chat is the `chat` event; speaking is `sendChat()` —
LLMs, rule engines, message bridges all plug in here:

```ts
import { Session } from "./src/client/session.ts";
import { parseConnectTarget, resolveTarget } from "./src/masterserver/target.ts";

const target = await resolveTarget(parseConnectTarget("1.2.3.4:5123"), null);
const session = new Session(target, { playerName: "my-bot" });

session.on("chat", (chat) => {
  if (!chat.senderName) return; // skip system messages
  // Without slot information, avoid automatic replies to unidentified own echoes.
  if (chat.senderTeamId === null || chat.senderTeamId < 0 || session.yourTeamId < 0) return;
  if (chat.senderTeamId === session.yourTeamId) return;
  // ↓ your own logic here: call an LLM, match rules, forward to another platform…
  session.sendChat(`echo: ${chat.message}`);
});

session.on("stateChange", (s) => console.log("state:", s));
await session.start();
```

`senderTeamId` and `yourTeamId` identify player slots on the current connection, not names or alliance IDs. The alliance client may decorate displayed names, and servers may rename players to resolve duplicates. Do not identify yourself by a fixed nickname or by stripping numeric prefixes. Older chat formats lack the sender slot; this example skips automatic replies until a reliable identity mapping is separately verified.

`session.roster` is the current roster (AI / spectators / ping / shared control). `connectionActive` means recent activity derived from server-reported ping, not real-time TCP status. `session.info.serverUuid` is a server identity field; shared relays can reuse it across rooms, so it cannot alone identify a room.
For multi-room orchestration use `runMultiRooms()` (see `src/client/multi.ts`), one handle per room.

Listen for `inputRequest` and call `request.respond(answer)` for server prompts; `null` cancels. Alternatively, return the answer from `SessionOptions.onInputRequest`. Single-room CLI uses the next line as an answer; unknown 117 prompts wait for input with a default 60-second timeout. Public-list password rooms require `PASSWORD` before address resolution. The multi-room library accepts `onInputRequest`; the multi-room CLI has no command for answering arbitrary prompts per room.

Register state listeners on the same `session` before `start()`:

```ts
session.on("settingsChange", settings => console.log("paused:", settings.gamePaused));
session.on("phaseChange", phase => console.log("phase:", phase));
session.on("gameStart", start => console.log("map:", start.mapType, start.mapPath));
session.on("gameEnded", () => console.log("round ended"));
```

Connection `state` and game `phase` are independent; pause does not mean return to lobby. `gameEnded` signals a server-ended round or return to lobby after a game, once per round, rather than a TCP disconnection. In-game map information comes from `gameStartInfo?.mapPath`, lobby information from `roomInfo?.mapPath`; fields may be unavailable before the corresponding packets arrive.

For optional reconnect, replace the construction above with:

```ts
import { ReconnectingSession } from "./src/client/reconnecting.ts";

const session = new ReconnectingSession("rkzxxxx", { playerName: "my-bot" }, {
  enabled: true, maxRetries: 10,
});
// Attach the listeners above, then await session.start().
// session.disconnect() exits and cancels further retries.
```

Plain `Session` detects disconnections without retrying; keep using it when an external Worker owns retries. Rejoining restores chat, not game simulation, and does not guarantee the same slot.

## Units checksum (UNITS_CHECKSUM)

The v176 constant 678359601 is built in as the default. Extract custom checksums with the capture tool; other versions may also require changes to packet structures, so replacing this constant alone does not establish compatibility:

```bash
npx tsx tools/capture-server.ts 5123     # listens on 127.0.0.1:5123 (auto-replies 161 for the synthesis)
# real client → Multiplayer → Direct Join → 127.0.0.1:5123
# the console prints ★ checksum / g() formula comparison / h() format
# Set the captured UNITS_CHECKSUM in .env, then join using --env-file as above.
```

## Environment variables

See [.env.example](.env.example): `NAME` / `PASSWORD` / `LANGUAGE` / `REGISTER_FORMAT` /
`UNITS_CHECKSUM` / `RELAY_ROOM_ID` / `CLIENT_UUID` / `RW_SOCKS_PROXY` / `DEBUG`.

The default Session join budget is 45 seconds including relay redirects; after joining, 60 seconds without a complete protocol frame triggers disconnection. Configure `JOIN_TIMEOUT_MS` and `RECEIVE_TIMEOUT_MS`; 0 disables the corresponding Session timer. Waiting for server-requested input pauses the join budget and uses a separate input timeout. Quiet chat or missing 109 responses to client 108 packets alone do not indicate a dead connection.

The multi-room runner also has a default 45-second startup settlement wait that closes sessions still waiting to join. Setting `JOIN_TIMEOUT_MS` to 0 or a larger value alone does not disable or extend this outer wait. Library callers can configure `settleTimeoutMs`.

Set `AUTO_RECONNECT=1` for optional CLI / multi-room retries (off by default). Each retry resolves the original target again and preserves the identity seed and SOCKS proxy. Defaults: `RECONNECT_MAX_RETRIES=10`, `RECONNECT_BASE_MS=5000`, `RECONNECT_MAX_MS=60000`; exponential waits of 5/10/20/40/60 seconds with jitter, capped at 60 seconds. Successful joins do not reset the total retry budget. Kicks, unavailable rooms and manual exits stop retries. Use `ReconnectingSession` explicitly in library code and avoid duplicating an external Worker's retry loop. See [lifecycle details](docs/ROSTER-STATE-FIX.md).

## Client identity (one per deployment, persistent by default)

The client's identity toward a server (clientId) is derived from a client UUID: `SHA256(uuid + per-hop serverUuid)` (64 uppercase hex characters),
mimicking how the real client derives it hop by hop. Default behavior of this UUID:

- **Generated randomly on first run**, persisted in `data/client-uuid` — one per deployment, all different,
  stable across process restarts (reconnect with the same identity and server-side recognition both depend on it)
- To change identity: delete `data/client-uuid` and restart the process, or set `CLIENT_UUID` to override explicitly
- Containers / CI without persistent disk: set `CLIENT_UUID` explicitly, otherwise every container rebuild is a new identity
- `data/` is already in `.gitignore`; the identity file won't be committed by accident

Default persistence requires a writable `data/`; read-only environments fall back to an identity valid only for the current process. Give separate deployments separate data directories or explicit UUIDs.

In multi-room mode all sessions share the same base UUID, distinguished only by the `-m1/-m2/…` slot suffix.
The upgrade from lowercase to vanilla uppercase identity hashes may make a server recognize a new identity even when the base UUID is unchanged.

## Tools (tools/)

- `capture-server.ts` — fake server that captures a real client's registration fingerprint / checksum
- `proxy-capture.ts` — man-in-the-middle capture proxy
- `probe.ts` — quick behavior probe of a target server
- `GoldenG.java` / `golden-g.txt` — g() formula reference implementation and test vectors
- `dump-descriptors.mjs` — print packet descriptors

## Etiquette

This client joins **other people's servers**. Please:

- Servers may rate-limit connections and chat with their own thresholds; keep reconnect backoff and apply rate limits to your bot's replies
- Make the bot obvious (pick a recognizable name); don't pose as a human
- Don't squat in someone's room without the host's consent; leave when kicked
- Entered room codes normally answer explicit room-ID 117 prompts automatically; use `RELAY_ROOM_ID` as an override when connecting directly to a relay (`new` creates a hosted room, which this project does not support)

## Development

```bash
npm test              # protocol, session, multi-room and lifecycle tests
npm run typecheck     # tsc --noEmit
npm run test:coverage # explicitly selected protocol and client modules, not the entire repository
```

## License

AGPL-3.0-only (GNU Affero General Public License, version 3 only), see [LICENSE](LICENSE).
