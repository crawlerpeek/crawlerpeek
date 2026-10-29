import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMcpServer, serveStdio, CACHE_TTL_MS } from "../src/mcp.js";
import { mockFetch, publicResolve } from "./helpers.js";

const routes = { "https://a.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /\n", headers: { "content-type": "text/plain" } }, "https://a.com/": { body: "<title>T</title>" } };
const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP server", () => {
  it("initializes and lists exactly six read-only tools", async () => {
    const s = createMcpServer();
    const init = (await s.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("crawlerpeek");
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await s.handle(rpc(2, "tools/list"))) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["check_ai_access", "see_as_bot", "verify_bot_ip", "generate_robots_txt", "lint_robots_txt", "scan_site"]);
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
  it("answers a 2025-11-25 client with that version and falls back for unknown ones", async () => {
    const s = createMcpServer();
    expect(await s.handle(rpc(1, "initialize", { protocolVersion: "2025-11-25" }))).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(await s.handle(rpc(2, "initialize", { protocolVersion: "2031-01-01" }))).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  });
  it("answers non-object messages with -32600", async () => {
    const s = createMcpServer();
    for (const bad of [null, 5, "x", []]) expect(await s.handle(bad as never)).toMatchObject({ id: null, error: { code: -32600 } });
  });
  it("lints a URL or pasted text, and requires exactly one of them", async () => {
    const m = mockFetch({ "https://a.com/robots.txt": { body: "User-agent: *\nDissallow: /a\n", headers: { "content-type": "text/plain" } } });
    const s = createMcpServer({ net: { fetch: m.fetch, resolve: publicResolve, delayMs: 0 } });
    const call = (args: Record<string, unknown>) => s.handle(rpc(1, "tools/call", { name: "lint_robots_txt", arguments: args })) as Promise<{ result: { isError?: boolean; content: { text: string }[]; structuredContent: { source: string; findings: { code: string }[]; counts: Record<string, number> } } }>;
    const byUrl = await call({ url: "https://a.com/" });
    expect(byUrl.result.structuredContent).toMatchObject({ source: "https://a.com/robots.txt", counts: { warning: 1 } });
    expect(byUrl.result.structuredContent.findings.map((f) => f.code)).toContain("unknown-field");
    await call({ url: "https://a.com/" });
    expect(m.calls).toHaveLength(1); // cached
    const byText = await call({ text: "User-agent: *\nDisallow: /\n" });
    expect(byText.result.structuredContent.source).toBe("text");
    expect(byText.result.structuredContent.findings.map((f) => f.code)).toEqual(["all-ai-blocked"]);
    for (const bad of [{}, { url: "https://a.com/", text: "x" }, { url: 5 }, { text: 5 }, { text: "x".repeat(2_000_001) }]) {
      const r = await call(bad);
      expect(r.result.isError, JSON.stringify(bad).slice(0, 40)).toBe(true);
    }
    expect((await call({})).result.content[0].text).toContain("exactly one of url or text");
  });
  it("scans a sitemap through the tool and validates its input", async () => {
    const m = mockFetch({
      "https://a.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /p/\nSitemap: https://a.com/sm.xml\n", headers: { "content-type": "text/plain" } },
      "https://a.com/sm.xml": { body: "<urlset><url><loc>https://a.com/p/1</loc></url><url><loc>https://a.com/q</loc></url></urlset>", headers: { "content-type": "application/xml" } },
    });
    const s = createMcpServer({ net: { fetch: m.fetch, resolve: publicResolve, delayMs: 0 } });
    const call = (args: Record<string, unknown>) => s.handle(rpc(1, "tools/call", { name: "scan_site", arguments: args })) as Promise<{ result: { isError?: boolean; content: { text: string }[]; structuredContent: { urls: { url: string; blockedFor: string[] }[]; summary: { perBot: { bot: string; blocked: number }[] } } } }>;
    const ok = await call({ url: "https://a.com/", bots: ["GPTBot", "ClaudeBot"], limit: 10 });
    expect(ok.result.structuredContent.urls).toEqual([{ url: "https://a.com/p/1", blockedFor: ["GPTBot"] }, { url: "https://a.com/q", blockedFor: [] }]);
    expect(ok.result.structuredContent.summary.perBot).toEqual([{ bot: "GPTBot", blocked: 1 }, { bot: "ClaudeBot", blocked: 0 }]);
    expect(m.calls.map((c) => c.url)).toEqual(["https://a.com/robots.txt", "https://a.com/sm.xml"]);
    for (const bad of [{}, { url: "https://a.com/", limit: "5" }, { url: "https://a.com/", limit: 500 }, { url: "https://a.com/", bots: "GPTBot" }, { url: "https://a.com/", bots: ["NopeBot"] }]) {
      expect((await call(bad)).result.isError, JSON.stringify(bad)).toBe(true);
    }
  });
  it("rejects unknown tools and methods", async () => {
    const s = createMcpServer();
    expect(await s.handle(rpc(1, "tools/call", { name: "delete_everything" }))).toMatchObject({ error: { code: -32602 } });
    expect(await s.handle(rpc(2, "resources/list"))).toMatchObject({ error: { code: -32601 } });
  });
});
