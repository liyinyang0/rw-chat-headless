import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadOrCreateClientUuid } from "../src/protocol/identity.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rw-chat-headless-identity-")), "client-uuid");
}

describe("loadOrCreateClientUuid", () => {
  it("首次生成随机 UUID 并持久化；再次调用返回同值", () => {
    const file = tmpPath();
    const first = loadOrCreateClientUuid(file);
    expect(first).toMatch(UUID_RE);
    expect(readFileSync(file, "utf8").trim()).toBe(first);
    expect(loadOrCreateClientUuid(file)).toBe(first);
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it("不同部署生成不同 UUID（默认身份互不相同）", () => {
    const a = tmpPath();
    const b = tmpPath();
    expect(loadOrCreateClientUuid(a)).not.toBe(loadOrCreateClientUuid(b));
    rmSync(dirname(a), { recursive: true, force: true });
    rmSync(dirname(b), { recursive: true, force: true });
  });

  it("身份文件目录不存在时自动创建", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-chat-headless-nested-"));
    const file = join(dir, "data", "client-uuid");
    const uuid = loadOrCreateClientUuid(file);
    expect(uuid).toMatch(UUID_RE);
    expect(readFileSync(file, "utf8").trim()).toBe(uuid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件内容非法时重新生成并覆盖", () => {
    const file = tmpPath();
    writeFileSync(file, "not-a-uuid\n");
    const regenerated = loadOrCreateClientUuid(file);
    expect(regenerated).toMatch(UUID_RE);
    expect(readFileSync(file, "utf8").trim()).toBe(regenerated);
    rmSync(dirname(file), { recursive: true, force: true });
  });
});
