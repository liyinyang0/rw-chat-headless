import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RwConnection, parseSocksProxy } from "../src/client/connection.ts";
import { encodeFrame } from "../src/protocol/frame.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("RwConnection SOCKS5", () => {
  it("通过 SOCKS5 域名请求连接目标，并继续解码代理后的游戏帧", async () => {
    let requestedHost = "";
    let requestedPort = 0;
    const server = createServer((socket) => {
      let pending = Buffer.alloc(0);
      let stage = 0;
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (stage === 0 && pending.length >= 3) {
          expect([...pending.subarray(0, 3)]).toEqual([5, 1, 0]);
          pending = pending.subarray(3);
          stage = 1;
          socket.write(Buffer.from([5, 0]));
        }
        if (stage === 1 && pending.length >= 5) {
          const hostLength = pending[4]!;
          const requestLength = 7 + hostLength;
          if (pending.length < requestLength) return;
          expect([...pending.subarray(0, 4)]).toEqual([5, 1, 0, 3]);
          requestedHost = pending.subarray(5, 5 + hostLength).toString("utf8");
          requestedPort = pending.readUInt16BE(5 + hostLength);
          stage = 2;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.write(encodeFrame(999, Buffer.from("ok")));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test proxy did not bind");

    const conn = new RwConnection({
      host: "r.relay.corrodinggames.com",
      port: 5123,
      socksProxy: { host: "127.0.0.1", port: address.port },
    });
    const framePromise = once(conn, "frame");
    await conn.connect();
    const [frame] = await framePromise;
    expect(requestedHost).toBe("r.relay.corrodinggames.com");
    expect(requestedPort).toBe(5123);
    expect(frame.type).toBe(999);
    expect(frame.payload.toString("utf8")).toBe("ok");
    conn.close();
  });

  it("代理拒绝连接时返回明确错误", async () => {
    const server = createServer((socket) => socket.once("data", () => socket.end(Buffer.from([5, 0xff]))));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test proxy did not bind");

    const conn = new RwConnection({
      host: "r.relay.corrodinggames.com",
      port: 5123,
      socksProxy: { host: "127.0.0.1", port: address.port },
    });
    await expect(conn.connect()).rejects.toThrow(/SOCKS5.*authentication/i);
  });
});

describe("parseSocksProxy", () => {
  it("只接受 host:port，并校验端口范围", () => {
    expect(parseSocksProxy("127.0.0.1:41081")).toEqual({ host: "127.0.0.1", port: 41081 });
    expect(() => parseSocksProxy("http://127.0.0.1:41081")).toThrow(/host:port/);
    expect(() => parseSocksProxy("127.0.0.1:0")).toThrow(/port/);
    expect(() => parseSocksProxy("127.0.0.1:70000")).toThrow(/port/);
  });
});
