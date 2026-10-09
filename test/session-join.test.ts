import { createServer, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../src/client/session.ts";
import { ByteReader, ByteWriter } from "../src/protocol/primitives.ts";
import { FrameDecoder, encodeFrame, type Frame } from "../src/protocol/frame.ts";
import { writeBlock } from "../src/protocol/block.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

function preregister(version = 176): Buffer {
  return new ByteWriter().writeUTF("com.corrodinggames.rts").writeInt(2).writeInt(version).writeInt(version)
    .writeUTF("com.corrodinggames.rts.java").writeUTF("fixture-room").writeInt(12345).writeInt(6789).writeInt(0).toBuffer();
}

function roster(): Buffer {
  const w = new ByteWriter().writeInt(0).writeBoolean(true).writeInt(1);
  const team = new ByteWriter().writeBoolean(true).writeInt(0).writeByte(0).writeInt(0).writeBoolean(true).writeBoolean(true);
  writeBlock(w, "teams", gzipSync(team.toBuffer()));
  return w.toBuffer();
}

function redirect(address: string): Buffer {
  return new ByteWriter().writeByte(0).writeInt(0).writeBoolean(true).writeInt(1).writeUTF(address).toBuffer();
}

async function listen(handler: (frame: Frame, socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.feed(chunk)) handler(frame, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return address.port;
}

function waitState(session: Session, wanted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`wanted ${wanted}, got ${session.state}`)); }, 1500);
    const onState = (state: string) => {
      if (state === wanted) { off(); resolve(); }
      else if (state === "kicked" || state === "disconnected") { off(); reject(new Error(state)); }
    };
    const off = () => { clearTimeout(timer); session.off("stateChange", onState); };
    session.on("stateChange", onState);
  });
}

describe("vanilla room join over TCP", () => {
  it("follows binary redirects, preserves the route, answers PoW and exchanges chat", async () => {
    let query: string | null = null;
    let answer = "";
    let challengeAnswer = "";
    const received: string[] = [];
    const roomPort = await listen((frame, socket) => {
      const send = (type: number, payload: Buffer) => socket.write(encodeFrame(type, payload));
      if (frame.type === 160) {
        const r = new ByteReader(frame.payload);
        r.readUTF(); r.readInt(); r.readInt(); r.readInt(); query = r.readNullableString();
        send(161, preregister());
      } else if (frame.type === 110) {
        send(151, new ByteWriter().writeInt(1).writeInt(5).writeBoolean(false).writeBoolean(false)
          .writeUTF("0B1ACB9CD5FB07").writeUTF("audit-").writeInt(3).toBuffer());
        send(117, new ByteWriter().writeByte(0).writeInt(9).writeUTF("请输入房间号").toBuffer());
      } else if (frame.type === 152) {
        const r = new ByteReader(frame.payload); r.readInt(); r.readInt(); challengeAnswer = r.readUTF();
      } else if (frame.type === 118) {
        const r = new ByteReader(frame.payload); r.readByte(); r.readInt(); answer = r.readUTF();
      } else if (frame.type === 140) {
        const text = new ByteReader(frame.payload).readUTF(); received.push(text);
        send(141, new ByteWriter().writeUTF(text).writeByte(3).writeStringNullable("audit")
          .writeInt(1).writeInt(0).toBuffer());
      }
      if ((frame.type === 118 || frame.type === 152) && answer && challengeAnswer === "3") send(115, roster());
    });
    const entryPort = await listen((frame, socket) => {
      if (frame.type === 160) socket.write(encodeFrame(178, redirect(`[TCP]127.0.0.1:${roomPort}/房间:7000`)));
    });
    const session = new Session({ host: "127.0.0.1", port: entryPort, queryString: "entry-code", label: "fixture" },
      { playerName: "audit", clientUuid: "audit-seed" });
    cleanup.push(() => session.disconnect());
    const joined = waitState(session, "battleroom");
    await session.start(); await joined;
    expect(query).toBe("房间:7000"); expect(answer).toBe(query);
    expect(session.info?.serverUuid).toBe("fixture-room");
    const echoed = new Promise<string>((resolve) => session.once("chat", (chat) => resolve(chat.message)));
    expect(session.sendChat("vanilla-roundtrip")).toBe(true);
    await expect(echoed).resolves.toBe("vanilla-roundtrip");
    expect(received).toEqual(["vanilla-roundtrip"]);
  });
});

describe("session registration and input lifecycle", () => {
  function fixture(options: Record<string, unknown> = {}) {
    const session = new Session({ host: "example.com", port: 5123, queryString: "r12345", label: "fixture" },
      { playerName: "audit", clientUuid: "audit-seed", ...options });
    const conn = { send: vi.fn(), close: vi.fn(), isClosed: false };
    (session as any).conn = conn;
    cleanup.push(() => session.disconnect());
    return { session, conn };
  }

  it("reports its own supported version and checksum rather than impersonating 161", () => {
    const { session, conn } = fixture();
    (session as any).handleFrame({ type: 161, payload: preregister(151) });
    const r = new ByteReader(conn.send.mock.calls[0]![1]);
    r.readUTF(); r.readInt(); expect(r.readInt()).toBe(176); expect(r.readInt()).toBe(176);
    r.readUTF(); r.readNullableString(); r.readUTF(); r.readUTF(); expect(r.readInt()).toBe(678359601);
  });

  it("answers a password prompt with the configured password, never the room code", () => {
    const { session, conn } = fixture({ password: "secret" });
    (session as any).handleFrame({ type: 117, payload: new ByteWriter().writeByte(0).writeInt(8).writeUTF("Enter password").toBuffer() });
    const r = new ByteReader(conn.send.mock.calls[0]![1]); r.readByte(); expect(r.readInt()).toBe(8);
    expect(r.readUTF()).toBe("secret");
  });

  it("exposes unknown prompts and ignores answers after cancellation", () => {
    const { session, conn } = fixture();
    const requests: any[] = [];
    (session as any).on("inputRequest", (request: unknown) => requests.push(request));
    (session as any).handleFrame({ type: 117, payload: new ByteWriter().writeByte(0).writeInt(8).writeUTF("Choose an option").toBuffer() });
    expect(conn.send).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
    session.disconnect(); requests[0].respond("late"); expect(conn.send.mock.calls.filter((call) => call[0] === 118)).toHaveLength(0);
  });

  it("allows interactive 113 password retry with a fresh registration", () => {
    const { session, conn } = fixture();
    (session as any).handleFrame({ type: 161, payload: preregister() }); conn.send.mockClear();
    (session as any).on("inputRequest", (request: any) => request.respond("test-password"));
    (session as any).handleFrame({ type: 113, payload: new ByteWriter().writeInt(0).toBuffer() });
    expect(conn.send.mock.calls[0]?.[0]).toBe(110);
    const r = new ByteReader(conn.send.mock.calls[0]![1]); r.readUTF(); r.readInt(); r.readInt(); r.readInt(); r.readUTF();
    expect(r.readNullableString()).toBe("C638833F69BBFB3C267AFA0A74434812436B8F08A81FD263C6BE6871DE4F1265");
  });

  it("terminates malformed redirects and exhausted redirect budgets", () => {
    const { session } = fixture();
    (session as any).handleFrame({ type: 178, payload: Buffer.alloc(0) }); expect(session.state).toBe("disconnected");
    const other = fixture(); (other.session as any).redirects = 3;
    (other.session as any).handleFrame({ type: 178, payload: redirect("example.com") });
    expect(other.session.state).toBe("disconnected");
  });
});
