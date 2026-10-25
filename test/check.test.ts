import { describe, expect, it } from "vitest";
import { checkAiAccess, failingBots, seeAsBot, extractTitle } from "../src/index.js";
import { main } from "../src/cli.js";
import { mockFetch, publicResolve } from "./helpers.js";

const PAGE = "<html><head><title>Hello &amp; welcome</title></head><body>ok</body></html>";
const base = { resolve: publicResolve, delayMs: 0 };

describe("seeAsBot", () => {
  it("reports status, final URL after redirects, type, size and title", async () => {
    const m = mockFetch({
      "https://a.com/": { status: 301, headers: { location: "https://www.a.com/" } },
      "https://www.a.com/": { status: 200, body: PAGE },
    });
    const r = await seeAsBot("https://a.com/", "GPTBot", { ...base, fetch: m.fetch });
    expect(r).toMatchObject({ status: 200, finalUrl: "https://www.a.com/", redirects: 1, title: "Hello & welcome", outcome: "ok", looksBlocked: false, bytes: PAGE.length });
    expect(m.calls[0].ua).toContain("GPTBot");
  });
  it("flags challenge pages and 403s", async () => {
    const cf = mockFetch({ "https://a.com/": { status: 200, body: "<title>Just a moment...</title> cf-chl-opt" } });
    expect(await seeAsBot("https://a.com/", "ClaudeBot", { ...base, fetch: cf.fetch })).toMatchObject({ looksBlocked: true, outcome: "blocked" });
    const f = mockFetch({ "https://a.com/": { status: 403, body: "no" } });
    expect(await seeAsBot("https://a.com/", "ClaudeBot", { ...base, fetch: f.fetch })).toMatchObject({ status: 403, blockReason: "HTTP 403", outcome: "blocked" });
  });
  it("stops after 5 redirects and reports an error, not a throw", async () => {
    const m = mockFetch({ "https://a.com/": { status: 302, headers: { location: "https://a.com/" } } });
    const r = await seeAsBot("https://a.com/", "GPTBot", { ...base, fetch: m.fetch });
    expect(r.fetched).toBe(false);
    expect(r.error).toMatch(/redirects/);
    expect(m.calls.length).toBe(6);
  });
  it("caps the body at 2 MB", async () => {
    const m = mockFetch({ "https://a.com/": { body: "x".repeat(3 * 1024 * 1024) } });
    const r = await seeAsBot("https://a.com/", "GPTBot", { ...base, fetch: m.fetch });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(2 * 1024 * 1024);
  });
  it("refuses control tokens and unknown bots", async () => {
    await expect(seeAsBot("https://a.com/", "Google-Extended", base)).rejects.toThrow(/control token/);
    await expect(seeAsBot("https://a.com/", "NopeBot", base)).rejects.toThrow(/Unknown bot/);
  });
  it("extracts titles safely", () => {
    expect(extractTitle("<TITLE>\n  A\u0000 &#39;x&#39;  </TITLE>")).toBe("A 'x'");
    expect(extractTitle('<title lang="de">Hallo</TITLE >')).toBe("Hallo");
    expect(extractTitle("<titlex>no</titlex><title>yes</title>")).toBe("yes");
    expect(extractTitle("<title>never closed")).toBe("");
    expect(extractTitle("İ<title>after dotted capital i</title>")).toBe("after dotted capital i");
  });
  it("extracts titles in linear time from hostile pages", () => {
    const t = Date.now();
    for (const html of ["<title".repeat(100_000), "<title>".repeat(85_000), "<title ".repeat(85_000), "<title>x</title".repeat(40_000)]) extractTitle(html);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("SSRF guard", () => {
  it("refuses private, loopback, link-local and metadata targets after DNS resolution", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fd00::1"]) {
      await expect(checkAiAccess("https://evil.example/", { resolve: async () => [ip], fetch: mockFetch({}).fetch })).rejects.toThrow(/private|loopback/);
    }
    await expect(seeAsBot("http://127.0.0.1/", "GPTBot", { fetch: mockFetch({}).fetch })).rejects.toThrow(/private/);
    await expect(seeAsBot("http://localhost:3000/", "GPTBot", { resolve: async () => ["127.0.0.1"] })).rejects.toThrow();
  });
  it("re-checks every redirect hop", async () => {
    const m = mockFetch({ "https://a.com/": { status: 302, headers: { location: "http://169.254.169.254/latest" } } });
    const r = await seeAsBot("https://a.com/", "GPTBot", { fetch: m.fetch, resolve: publicResolve });
    expect(r).toMatchObject({ fetched: false, outcome: "error" });
    expect(r.error).toMatch(/Redirect refused.*private/);
    expect(m.calls.length).toBe(1);
  });
  it("reports a refused redirect per bot and for robots.txt instead of aborting the run", async () => {
    for (const location of ["http://169.254.169.254/", "http://[::1]/", "ftp://x/", "https://a.com:22/"]) {
      const m = mockFetch({
        "https://a.com/robots.txt": { status: 302, headers: { location } },
        "https://a.com/": (ua) => (ua.includes("ClaudeBot") ? { status: 302, headers: { location } } : { body: PAGE }),
      });
      const r = await checkAiAccess("https://a.com/", { ...base, fetch: m.fetch, bots: ["GPTBot", "ClaudeBot"] });
      expect(r.robotsTxt).toMatchObject({ state: "unavailable" });
      expect(r.robotsTxt.error).toMatch(/Redirect refused/);
      expect(r.bots[0].robots.access).toBe("unknown");
      expect(r.bots[0].http?.outcome).toBe("ok");
      expect(r.bots[1].http).toMatchObject({ outcome: "error", fetched: false });
      expect(r.bots[1].http?.error).toMatch(/Redirect refused/);
      expect(failingBots(r, "blocked")).toEqual([]);
    }
  });
  it("still throws when the supplied URL itself is refused", async () => {
    await expect(checkAiAccess("http://169.254.169.254/", { ...base, resolve: undefined, fetch: mockFetch({}).fetch })).rejects.toThrow(/private/);
    await expect(checkAiAccess("ftp://a.com/", { ...base, fetch: mockFetch({}).fetch })).rejects.toThrow(/http/);
  });
  it("treats a 3xx robots.txt without Location as unreachable", async () => {
    const m = mockFetch({ "https://a.com/robots.txt": { status: 301, body: "User-agent: *\nDisallow: /\n", headers: { "content-type": "text/plain" } }, "https://a.com/": { body: PAGE } });
    const r = await checkAiAccess("https://a.com/", { ...base, fetch: m.fetch, bots: ["GPTBot"], http: false });
    expect(r.robotsTxt).toMatchObject({ state: "unavailable", status: 301 });
    expect(r.bots[0].robots.access).toBe("unknown");
  });
  it("refuses odd ports and non-http schemes; --allow-private lifts the guard", async () => {
    await expect(seeAsBot("https://a.com:8443/", "GPTBot", { ...base, fetch: mockFetch({}).fetch })).rejects.toThrow(/ports/);
    await expect(seeAsBot("file:///etc/passwd", "GPTBot", base)).rejects.toThrow(/http/);
    const m = mockFetch({ "http://127.0.0.1:3000/": { body: PAGE } });
    expect((await seeAsBot("http://127.0.0.1:3000/", "GPTBot", { allowPrivate: true, fetch: m.fetch })).status).toBe(200);
  });
  it("fetches nothing in the default transport when the host resolves privately", async () => {
    await expect(seeAsBot("https://rebind.example/", "GPTBot", { resolve: async () => ["127.0.0.1"] })).rejects.toThrow(/private/);
  });
});

describe("checkAiAccess", () => {
  const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
  const routes = (blockClaude = false) => ({
    "https://a.com/robots.txt": { body: robots, headers: { "content-type": "text/plain" } },
    "https://a.com/pricing": (ua: string) => (blockClaude && ua.includes("ClaudeBot") ? { status: 403, body: "denied" } : { body: PAGE }),
  });
  it("combines robots decision and HTTP per bot, sequentially, one request per bot", async () => {
    const m = mockFetch(routes());
    const r = await checkAiAccess("https://a.com/pricing", { ...base, fetch: m.fetch, bots: ["GPTBot", "ClaudeBot", "Google-Extended"] });
    expect(r.robotsTxt.state).toBe("ok");
    const by = Object.fromEntries(r.bots.map((b) => [b.bot, b]));
    expect(by.GPTBot.robots).toMatchObject({ access: "blocked", pathAllowed: false });
    expect(by.ClaudeBot.robots.pathAllowed).toBe(true);
    expect(by["Google-Extended"].http).toBeNull();
    expect(m.calls.filter((c) => c.url.endsWith("/pricing")).length).toBe(2);
    expect(m.calls[0].ua).toMatch(/^crawlerpeek\//);
  });
  it("defaults to the 15 documented bots", async () => {
    const r = await checkAiAccess("https://a.com/pricing", { ...base, fetch: mockFetch(routes()).fetch });
    expect(r.bots.map((b) => b.bot)).toEqual(["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "Applebot-Extended", "CCBot", "meta-externalagent", "Bytespider"]);
  });
  it("http:false checks robots.txt only", async () => {
    const m = mockFetch(routes());
    await checkAiAccess("https://a.com/pricing", { ...base, fetch: m.fetch, http: false });
    expect(m.calls.length).toBe(1);
  });
  it("treats a failing robots.txt as unknown, not blocked", async () => {
    const m = mockFetch({ "https://a.com/robots.txt": { status: 503 }, "https://a.com/": { body: PAGE } });
    const r = await checkAiAccess("https://a.com/", { ...base, fetch: m.fetch, bots: ["GPTBot"] });
    expect(r.robotsTxt.state).toBe("unavailable");
    expect(r.bots[0].robots.access).toBe("unknown");
    expect(failingBots(r, "blocked")).toEqual([]);
  });

  it("fail-on policies", async () => {
    const ok = await checkAiAccess("https://a.com/pricing", { ...base, fetch: mockFetch(routes()).fetch, bots: ["ClaudeBot", "CCBot"] });
    expect(failingBots(ok, "blocked")).toEqual([]);
    expect(failingBots(ok, "any-non-200")).toEqual([]);
    const blocked = await checkAiAccess("https://a.com/pricing", { ...base, fetch: mockFetch(routes(true)).fetch, bots: ["ClaudeBot", "GPTBot"] });
    expect(failingBots(blocked, "none")).toEqual([]);
    expect(failingBots(blocked, "blocked").sort()).toEqual(["ClaudeBot", "GPTBot"]);
    const missing = await checkAiAccess("https://a.com/gone", { ...base, fetch: mockFetch({ "https://a.com/robots.txt": { status: 404 }, "https://a.com/gone": { status: 404 } }).fetch, bots: ["CCBot"] });
    expect(failingBots(missing, "blocked")).toEqual([]);
    expect(failingBots(missing, "any-non-200")).toEqual(["CCBot"]);
  });
});

describe("CLI exit codes", () => {
  const run = async (args: string[], routes: Parameters<typeof mockFetch>[0]) => {
    void routes;
    const out: string[] = [], err: string[] = [];
    const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  it("2 on usage errors and private targets", async () => {
    expect((await run([], {})).code).toBe(2);
    expect((await run(["check"], {})).code).toBe(2);
    expect((await run(["check", "https://a.com", "--fail-on", "weird"], {})).code).toBe(2);
    expect((await run(["check", "http://127.0.0.1/"], {})).code).toBe(2);
    expect((await run(["bogus"], {})).code).toBe(2);
  });
  it("2 on unknown options instead of ignoring them", async () => {
    for (const args of [["check", "https://a.com", "--failon", "blocked"], ["check", "https://a.com", "--fail-on=blocked", "--no-http", "--nope"], ["check", "https://a.com", "-x"], ["see", "https://a.com", "--bot", "GPTBot", "--bots", "x"], ["robots", "--json"], ["mcp", "--verbose"], ["check", "https://a.com", "--json=1"]]) {
      const r = await run(args, {});
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(/Unknown option|takes no value/);
    }
    expect((await run(["check", "https://a.com", "--failon", "x"], {})).err).toContain("Unknown option --failon");
    expect((await run(["check", "https://a.com", "--failon", "x"], {})).err).toContain("--help");
  });
  it("lists none among the valid --fail-on values and documents --delay", async () => {
    expect((await run(["check", "https://a.com", "--fail-on", "weird"], {})).err).toContain("none, blocked or any-non-200");
    const h = await run(["check", "--help"], {});
    expect(h.code).toBe(0);
    expect(h.out).toContain("--delay");
  });
  it("see exits 2 when the request is refused", async () => {
    expect((await run(["see", "http://127.0.0.1/", "--bot", "GPTBot"], {})).code).toBe(2);
  });
  it("prints robots.txt and version with exit 0", async () => {
    const r = await run(["robots", "--disallow", "/admin/"], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("Disallow: /admin/");
    expect((await run(["--version"], {})).out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
