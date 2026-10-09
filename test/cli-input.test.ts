import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

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
