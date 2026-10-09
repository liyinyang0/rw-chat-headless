import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/protocol/frame.ts";
import { ByteWriter } from "../src/protocol/primitives.ts";
import { basicTeam, teamPacket } from "./fixtures/room-wire.ts";

it("exits when stdin closes while the connection handshake is pending", async () => {
  const sockets = new Set<Socket>();
  // SOCKS fixture intentionally leaves negotiation pending.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "join", "127.0.0.1:5123"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, CLIENT_UUID: "cli-input-test", RW_SOCKS_PROXY: `127.0.0.1:${address.port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let timer: NodeJS.Timeout | undefined;
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
      timer = setTimeout(() => reject(new Error(`CLI did not exit after EOF: ${output}`)), 3000);
    });
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(output).toContain("连接断开: stdin closed");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await stopped;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);

it("CLI opt-in reconnects after a real socket close and /quit cancels retries", async () => {
  const sockets = new Set<Socket>(); let connections = 0;
  let connectedTwice!: () => void;
  const secondJoin = new Promise<void>(resolve => { connectedTwice = resolve; });
  const server = createServer(socket => {
    const attempt = ++connections; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", (data: Buffer) => { for (const frame of decoder.feed(data)) {
      if (frame.type === 160) socket.write(encodeFrame(161, new ByteWriter().writeUTF("com.corrodinggames.rts").writeInt(2).writeInt(176).writeInt(176)
        .writeUTF("com.corrodinggames.rts.java").writeUTF("cli-reconnect").writeInt(1).writeInt(1).writeInt(0).toBuffer()));
      if (frame.type === 110) {
        socket.write(encodeFrame(115, teamPacket(false, [basicTeam(0, "host")])), () => {
          if (attempt === 1) setTimeout(() => socket.destroy(), 20);
          else connectedTwice();
        });
      }
    }});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "join", `127.0.0.1:${address.port}`], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RW_SOCKS_PROXY: "", CLIENT_UUID: "cli-reconnect-test", AUTO_RECONNECT: "1", RECONNECT_BASE_MS: "10", RECONNECT_MAX_MS: "20" },
  });
  let output = ""; child.stdout.on("data", c => { output += c.toString(); }); child.stderr.on("data", c => { output += c.toString(); });
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no reconnect: ${output}`)), 3000); });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  try {
    await Promise.race([secondJoin, expired]); child.stdin.write("/quit\n");
    expect(await Promise.race([exited, expired])).toBe(0); expect(connections).toBe(2); expect(output).toContain("reconnect #1");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);
