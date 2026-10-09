import { afterEach, describe, expect, it, vi } from "vitest";
import { getGameServer, listRooms } from "../src/masterserver/client.ts";
import { formatServerCode } from "../src/protocol/integrity.ts";
import { sha256ShortHash } from "../src/protocol/hashes.ts";

afterEach(() => vi.unstubAllGlobals());

function getResponse(host = "example.com", port = "5123"): Response {
  const columns = Array<string>(22).fill("");
  columns[3] = host; columns[5] = port;
  return new Response(`CORRODINGGAMES\nOK\n${sha256ShortHash("game_" + formatServerCode(12345))}\n\n${columns.join(",")}\n`);
}

describe("master-server valid response selection", () => {
  it.each(["<html>failure</html>", "CORRODINGGAMES [FAILED]\nERROR_WRONG_C\n"])
    ("waits for a valid node when the fastest HTTP 200 is %s", async (bad) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("gs1.")) return new Response(bad);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getResponse();
      }));
      await expect(getGameServer("id", 12345)).resolves.toEqual({ host: "example.com", port: 5123 });
    });

  it("waits for another node after an invalid integrity line", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("gs1.")) return new Response("CORRODINGGAMES\nOK\nwrong-check\n\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getResponse();
    }));
    await expect(getGameServer("id", 12345)).resolves.toEqual({ host: "example.com", port: 5123 });
  });

  it("aborts outstanding requests once a usable list wins", async () => {
    let loser: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url.includes("gs1.")) return Promise.resolve(new Response("CORRODINGGAMES\n"));
      loser = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => loser!.addEventListener("abort", () => reject(new Error("aborted"))));
    }));
    await expect(listRooms()).resolves.toEqual([]);
    expect(loser?.aborted).toBe(true);
  });

  it("reports the actual password error if every node rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("CORRODINGGAMES [FAILED]\nERROR_WRONG_PASSWORD\n")));
    await expect(getGameServer("id", 12345, "bad")).rejects.toThrow("Wrong password");
  });

  it.each(["0", "65536", "1.5"])("rejects an unusable returned port %s", async (port) => {
    vi.stubGlobal("fetch", vi.fn(async () => getResponse("example.com", port)));
    await expect(getGameServer("id", 12345)).rejects.toThrow(/address|port/i);
  });

  it("parses an actual 22-column room list and posts the original password hash", async () => {
    const columns = Array<string>(22).fill("");
    columns[0] = "fallback-id"; columns[2] = "176"; columns[3] = "example.com"; columns[5] = "5123";
    columns[6] = "true"; columns[7] = "host"; columns[8] = "true"; columns[15] = "2"; columns[16] = "10";
    columns[18] = "audit-room"; columns[20] = "mods"; columns[21] = "12345";
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (!init.body) return new Response(`CORRODINGGAMES\ninvalid-row\n${columns.join(",")}\n`);
      bodies.push(String(init.body)); return getResponse();
    }));
    const rooms = await listRooms(); expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ serverId: "audit-room", port: 5123, requiresPassword: true, currentPlayers: 2, modsRequired: "mods" });
    await getGameServer("audit-room", 12345, "test-password");
    expect(new URLSearchParams(bodies[0]).get("p_hash"))
      .toBe("A1F76F81A058A63BECBD2EC1114F8213EEDEA326F4051583CA6D09337B176BF7");
  });
});
