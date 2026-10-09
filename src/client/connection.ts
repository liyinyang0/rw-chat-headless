import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { FrameDecoder, encodeFrame, type Frame } from "../protocol/frame.ts";

export interface SocksProxyTarget {
  host: string;
  port: number;
}

export function parseSocksProxy(value?: string): SocksProxyTarget | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/\s|:\/\/|[/\\@]/.test(raw)) throw new Error("RW_SOCKS_PROXY must use host:port");
  const separator = raw.lastIndexOf(":");
  if (separator <= 0 || separator === raw.length - 1) throw new Error("RW_SOCKS_PROXY must use host:port");
  const host = raw.slice(0, separator);
  const port = Number(raw.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("RW_SOCKS_PROXY port is invalid");
  if (Buffer.byteLength(host, "utf8") > 255) throw new Error("RW_SOCKS_PROXY host is too long");
  return { host, port };
}

export interface RwConnectionOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  socksProxy?: SocksProxyTarget;
}

function readExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const read = () => {
      const chunk = socket.read(length) as Buffer | null;
      if (!chunk) return;
      cleanup();
      resolve(chunk);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("SOCKS5 proxy closed during handshake")); };
    const cleanup = () => {
      socket.off("readable", read);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("readable", read);
    socket.once("error", onError);
    socket.once("close", onClose);
    read();
  });
}

async function connectViaSocks5(socket: Socket, target: { host: string; port: number }): Promise<void> {
  const host = Buffer.from(target.host, "utf8");
  if (host.length === 0 || host.length > 255) throw new Error("SOCKS5 target host is invalid");

  socket.write(Buffer.from([5, 1, 0]));
  const authentication = await readExactly(socket, 2);
  if (authentication[0] !== 5 || authentication[1] !== 0) {
    throw new Error("SOCKS5 proxy rejected authentication method");
  }

  const request = Buffer.allocUnsafe(7 + host.length);
  request.set([5, 1, 0, 3, host.length], 0);
  host.copy(request, 5);
  request.writeUInt16BE(target.port, 5 + host.length);
  socket.write(request);

  const response = await readExactly(socket, 4);
  if (response[0] !== 5) throw new Error("SOCKS5 proxy returned an invalid response");
  if (response[1] !== 0) throw new Error(`SOCKS5 proxy connect failed with code ${response[1]}`);
  if (response[3] === 1) await readExactly(socket, 6);
  else if (response[3] === 4) await readExactly(socket, 18);
  else if (response[3] === 3) {
    const size = (await readExactly(socket, 1))[0]!;
    await readExactly(socket, size + 2);
  } else {
    throw new Error("SOCKS5 proxy returned an invalid address type");
  }
}

/**
 * TCP 连接 + 帧编解码。事件：
 *  - frame(Frame)：完整帧
 *  - close(reason)：socket 关闭
 *  - error(err)
 */
export class RwConnection extends EventEmitter {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private closed = false;
  readonly remoteLabel: string;

  constructor(private opts: RwConnectionOptions) {
    super();
    this.remoteLabel = `${opts.host}:${opts.port}`;
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("connection already closed"));
    return new Promise((resolve, reject) => {
      const onClose = (reason: string) => fail(new Error(reason));
      const fail = (error: Error) => { this.off("close", onClose); reject(error); };
      const connected = () => { this.off("close", onClose); resolve(); };
      this.once("close", onClose);
      const socket = new Socket();
      socket.setNoDelay(true);
      socket.setTimeout(this.opts.connectTimeoutMs ?? 7000);
      socket.once("connect", () => {
        void (async () => {
          try {
            if (this.opts.socksProxy) {
              await connectViaSocks5(socket, { host: this.opts.host, port: this.opts.port });
            }
            if (this.closed) return;
            socket.setTimeout(0);
            socket.on("data", (chunk: Buffer) => {
              let frames: Frame[];
              try {
                frames = this.decoder.feed(chunk);
              } catch (err) {
                this.close(`frame decode error: ${err instanceof Error ? err.message : err}`);
                return;
              }
              for (const f of frames) this.emit("frame", f);
            });
            socket.resume();
            connected();
          } catch (error) {
            socket.destroy();
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
      socket.once("timeout", () => {
        socket.destroy();
        fail(new Error(`connect timeout: ${this.remoteLabel}`));
      });
      socket.once("error", (err) => {
        if (this.closed) return;
        fail(new Error(`connect failed: ${this.remoteLabel}: ${err.message}`));
      });
      socket.once("close", () => {
        if (!this.closed) {
          this.closed = true;
          this.emit("close", "socket closed");
        }
      });
      const endpoint = this.opts.socksProxy ?? this.opts;
      socket.connect(endpoint.port, endpoint.host);
      this.socket = socket;
    });
  }

  send(type: number, payload: Buffer): void {
    if (!this.socket || this.closed) return;
    this.socket.write(encodeFrame(type, payload));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(reason = "client closing"): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", reason);
    this.socket?.destroy();
  }
}
