import { beforeEach, describe, expect, it } from "vitest";
import { clearVerifyCache, inCidr, parseIp, verifyBotIp, type DnsResolver } from "../src/verify.js";
import { createMcpServer } from "../src/mcp.js";
import { mockFetch, publicResolve } from "./helpers.js";

const json = { headers: { "content-type": "application/json" } };
const list = (...p: string[]) => ({ ...json, body: JSON.stringify({ prefixes: p.map((x) => (x.includes(":") ? { ipv6Prefix: x } : { ipv4Prefix: x })) }) });
const GPT = "https://openai.com/gptbot.json";
const dnsStub = (rev: Record<string, string[]>, fwd: Record<string, string[]>): DnsResolver => ({
  reverse: async (ip) => { if (!rev[ip]) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); return rev[ip]; },
  resolve4: async (h) => { if (!fwd[h]) throw Object.assign(new Error("nx"), { code: "ENODATA" }); return fwd[h]; },
  resolve6: async (h) => { if (!fwd[h]) throw Object.assign(new Error("nx"), { code: "ENODATA" }); return fwd[h]; },
});
beforeEach(clearVerifyCache);

describe("CIDR matching", () => {
  it("handles IPv4 edges", () => {
    expect(inCidr("10.0.0.0", "10.0.0.0/24")).toBe(true);
    expect(inCidr("10.0.0.255", "10.0.0.0/24")).toBe(true);
    expect(inCidr("10.0.1.0", "10.0.0.0/24")).toBe(false);
    expect(inCidr("1.2.3.4", "1.2.3.4/32")).toBe(true);
    expect(inCidr("1.2.3.5", "1.2.3.4/32")).toBe(false);
    expect(inCidr("1.2.3.4", "1.2.3.4")).toBe(true);
    expect(inCidr("200.1.1.1", "0.0.0.0/0")).toBe(true);
    expect(inCidr("1.2.3.4", "1.2.3.4/33")).toBe(false);
  });
  it("handles IPv6 forms", () => {
    expect(inCidr("2001:4860:4801:4004::1", "2001:4860:4801:4004::/64")).toBe(true);
    expect(inCidr("2001:4860:4801:4005::1", "2001:4860:4801:4004::/64")).toBe(false);
    expect(inCidr("2001:4860:4801:4004:ffff:ffff:ffff:ffff", "2001:4860:4801:4004::/64")).toBe(true);
    expect(inCidr("::1", "::1/128")).toBe(true);
    expect(inCidr("2001:db8::1", "2001:0db8:0000::/32")).toBe(true);
    expect(inCidr("2001:db8::1", "2001:db9::/32")).toBe(false);
  });
  it("keeps families apart and maps IPv4-in-IPv6", () => {
    expect(inCidr("::ffff:1.2.3.4", "1.2.3.0/24")).toBe(true);
    expect(parseIp("::ffff:102:304")).toMatchObject({ family: 4 });
    expect(inCidr("1.2.3.4", "::/0")).toBe(false);
    expect(inCidr("::1", "0.0.0.0/0")).toBe(false);
  });
  it("rejects garbage", () => {
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("fe80::1%eth0")).toBeNull();
    expect(parseIp("example.com")).toBeNull();
  });
});

describe("verifyBotIp", () => {
  it("verifies through the IP list and only fetches the bot's list", async () => {
    const m = mockFetch({ [GPT]: list("132.196.86.0/24", "2001:db8::/32") });
    const [r] = await verifyBotIp("132.196.86.7", { bot: "gptbot", fetch: m.fetch, resolve: publicResolve });
    expect(r).toMatchObject({ bot: "GPTBot", method: "ip-list", verified: true, source: GPT });
    const [r6] = await verifyBotIp("2001:db8::5", { bot: "GPTBot", fetch: m.fetch, resolve: publicResolve });
    expect(r6.verified).toBe(true);
    expect(m.calls).toHaveLength(1); // cached
  });
  it("reports false when the address is not listed", async () => {
    const m = mockFetch({ [GPT]: list("132.196.86.0/24") });
    const [r] = await verifyBotIp("8.8.8.8", { bot: "GPTBot", fetch: m.fetch, resolve: publicResolve });
    expect(r).toMatchObject({ method: "ip-list", verified: false });
  });
  it("returns null with the reason when the list cannot be fetched", async () => {
    const m = mockFetch({ [GPT]: { status: 503 } });
    const [r] = await verifyBotIp("132.196.86.7", { bot: "GPTBot", fetch: m.fetch, resolve: publicResolve });
    expect(r.verified).toBeNull();
    expect(r.detail).toContain("HTTP 503");
    const [r2] = await verifyBotIp("132.196.86.7", { bot: "GPTBot", fetch: mockFetch({ [GPT]: { body: "<html>" } }).fetch, resolve: publicResolve });
    expect(r2.verified).toBeNull();
  });
  it("refuses redirects", async () => {
    const m = mockFetch({ [GPT]: { status: 302, headers: { location: "https://evil.example/x.json" } } });
    const [r] = await verifyBotIp("1.1.1.1", { bot: "GPTBot", fetch: m.fetch, resolve: publicResolve });
    expect(r.verified).toBeNull();
    expect(m.calls).toHaveLength(1);
  });
  it("confirms reverse DNS only when the forward lookup returns the same address", async () => {
    const down = mockFetch({});
    const ok = dnsStub({ "66.249.66.1": ["crawl-66-249-66-1.googlebot.com."] }, { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] });
    const [a] = await verifyBotIp("66.249.66.1", { bot: "Googlebot", fetch: down.fetch, resolve: publicResolve, resolver: ok });
    expect(a).toMatchObject({ method: "reverse-dns", verified: true });
    const spoof = dnsStub({ "6.6.6.6": ["crawl-1-1-1-1.googlebot.com"] }, { "crawl-1-1-1-1.googlebot.com": ["1.1.1.1"] });
    const lists = Object.fromEntries(["common-crawlers", "special-crawlers", "user-triggered-agents", "user-triggered-fetchers", "user-triggered-fetchers-google"].map((n) => [`https://developers.google.com/static/crawling/ipranges/${n}.json`, list("66.249.64.0/19")]));
    const [b] = await verifyBotIp("6.6.6.6", { bot: "Googlebot", fetch: mockFetch(lists).fetch, resolve: publicResolve, resolver: spoof });
    expect(b.verified).toBe(false);
    expect(b.detail).toContain("forward confirmation failed");
    const other = dnsStub({ "6.6.6.6": ["evil.example.com"] }, {});
    const [c] = await verifyBotIp("6.6.6.6", { bot: "Bingbot", fetch: down.fetch, resolve: publicResolve, resolver: other });
    expect(c.verified).toBeNull(); // list unreachable and rDNS negative: undecided
  });
  it("does not accept a Google Cloud VM as Googlebot", async () => {
    const lists = Object.fromEntries(["common-crawlers", "special-crawlers", "user-triggered-agents", "user-triggered-fetchers", "user-triggered-fetchers-google"].map((n) => [`https://developers.google.com/static/crawling/ipranges/${n}.json`, list("66.249.64.0/19")]));
    const vm = dnsStub({ "35.190.0.1": ["1.0.190.35.bc.googleusercontent.com."] }, { "1.0.190.35.bc.googleusercontent.com": ["35.190.0.1"] });
    const [r] = await verifyBotIp("35.190.0.1", { bot: "Googlebot", fetch: mockFetch(lists).fetch, resolve: publicResolve, resolver: vm });
    expect(r.verified).toBe(false);
    const fetcher = dnsStub({ "35.190.0.2": ["fetcher.gae.googleusercontent.com."] }, { "fetcher.gae.googleusercontent.com": ["35.190.0.2"] });
    const [g] = await verifyBotIp("35.190.0.2", { bot: "Googlebot", fetch: mockFetch(lists).fetch, resolve: publicResolve, resolver: fetcher });
    expect(g.verified).toBe(true);
  });
  it("a matching list wins even if another list fails", async () => {
    const ok = Object.fromEntries(["special-crawlers", "user-triggered-agents", "user-triggered-fetchers", "user-triggered-fetchers-google"].map((n) => [`https://developers.google.com/static/crawling/ipranges/${n}.json`, { status: 500 }]));
    const m = mockFetch({ ...ok, "https://developers.google.com/static/crawling/ipranges/common-crawlers.json": list("66.249.64.0/19") });
    const [r] = await verifyBotIp("66.249.66.1", { bot: "Googlebot", fetch: m.fetch, resolve: publicResolve });
    expect(r).toMatchObject({ method: "ip-list", verified: true });
  });
  it("reads the Ahrefs list shape", async () => {
    const m = mockFetch({ "https://api.ahrefs.com/v3/public/crawler-ips": { ...json, body: JSON.stringify({ ips: [{ ip_address: "5.39.1.224" }] }) } });
    const [r] = await verifyBotIp("5.39.1.224", { bot: "AhrefsBot", fetch: m.fetch, resolve: publicResolve, resolver: dnsStub({}, {}) });
    expect(r.verified).toBe(true);
  });
  it("reports no method honestly and rejects unknown bots and bad IPs", async () => {
    const [r] = await verifyBotIp("1.2.3.4", { bot: "Bytespider" });
    expect(r).toMatchObject({ method: "none", verified: null });
    expect(r.detail).toContain("documents no");
    const [g] = await verifyBotIp("1.2.3.4", { bot: "Google-Extended" });
    expect(g.detail).toContain("never makes requests");
    await expect(verifyBotIp("1.2.3.4", { bot: "NopeBot" })).rejects.toThrow(/Unknown bot/);
    await expect(verifyBotIp("not-an-ip")).rejects.toThrow(/valid IPv4/);
  });
  it("is exposed as a read-only MCP tool", async () => {
    const m = mockFetch({ [GPT]: list("132.196.86.0/24") });
    const s = createMcpServer({ net: { fetch: m.fetch, resolve: publicResolve } });
    const r = await s.callTool("verify_bot_ip", { ip: "132.196.86.1", bot: "GPTBot" });
    expect(r.structuredContent).toMatchObject({ results: [{ bot: "GPTBot", verified: true }] });
    expect((await s.callTool("verify_bot_ip", {})).isError).toBe(true);
  });
});
