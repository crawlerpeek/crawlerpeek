import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMcpServer, serveStdio, CACHE_TTL_MS } from "../src/mcp.js";
import { mockFetch, publicResolve } from "./helpers.js";

const routes = { "https://a.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /\n", headers: { "content-type": "text/plain" } }, "https://a.com/": { body: "<title>T</title>" } };
const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP server", () => {
  it("initializes and lists exactly three read-only tools", async () => {
    const s = createMcpServer();
    const init = (await s.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("crawlerpeek");
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await s.handle(rpc(2, "tools/list"))) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["check_ai_access", "see_as_bot", "generate_robots_txt"]);
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
  it("tool call round trip over stdio", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const m = mockFetch(routes);
    const done = serveStdio(input, output, { net: { fetch: m.fetch, resolve: publicResolve, delayMs: 0 } });
    const lines: string[] = [];
    output.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
    input.write(JSON.stringify(rpc(1, "tools/call", { name: "check_ai_access", arguments: { url: "https://a.com/", bots: ["GPTBot", "ClaudeBot"] } })) + "\n");
    input.write("not json\n");
    input.write(JSON.stringify(rpc(3, "tools/call", { name: "generate_robots_txt", arguments: { disallow: ["/admin/"] } })) + "\n");
    input.end();
    await done;
    const res = lines.map((l) => JSON.parse(l));
    const first = res.find((r) => r.id === 1);
    expect(first.result.structuredContent.bots[0]).toMatchObject({ bot: "GPTBot", robots: { access: "blocked" } });
    expect(first.result.structuredContent.bots[1].robots.pathAllowed).toBe(true);
    expect(res.find((r) => r.error?.code === -32700)).toBeTruthy();
    expect(res.find((r) => r.id === 3).result.content[0].text).toContain("Disallow: /admin/");
  });
  it("refuses private targets through the tool and reports isError", async () => {
    const s = createMcpServer({ net: { resolve: async () => ["10.0.0.1"] } });
    const r = (await s.handle(rpc(1, "tools/call", { name: "see_as_bot", arguments: { url: "https://internal.example/", bot: "GPTBot" } }))) as { result: { isError: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/private/);
  });
  it("caches identical calls for 10 minutes, then refetches", async () => {
    let t = 1_000;
    const m = mockFetch(routes);
    const s = createMcpServer({ now: () => t, net: { fetch: m.fetch, resolve: publicResolve, delayMs: 0 } });
    const call = () => s.handle(rpc(1, "tools/call", { name: "see_as_bot", arguments: { url: "https://a.com/", bot: "GPTBot" } }));
    await call(); await call();
    expect(m.calls.length).toBe(1);
    t += CACHE_TTL_MS + 1;
    await call();
    expect(m.calls.length).toBe(2);
  });
  it("rejects unknown tools and methods", async () => {
    const s = createMcpServer();
    expect(await s.handle(rpc(1, "tools/call", { name: "delete_everything" }))).toMatchObject({ error: { code: -32602 } });
    expect(await s.handle(rpc(2, "resources/list"))).toMatchObject({ error: { code: -32601 } });
  });
});
