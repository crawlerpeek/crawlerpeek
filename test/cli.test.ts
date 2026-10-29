import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { mockFetch, publicResolve } from "./helpers.js";

const txt = { "content-type": "text/plain" };
const run = async (args: string[], routes: Parameters<typeof mockFetch>[0] = {}, stdin?: string) => {
  const out: string[] = [], err: string[] = [];
  const m = mockFetch(routes);
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), stdin: stdin === undefined ? undefined : async () => stdin }, { fetch: m.fetch, resolve: publicResolve });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: m.calls };
};
const dir = mkdtempSync(join(tmpdir(), "crawlerpeek-"));
const file = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };

describe("lint command", () => {
  it("prints one line per finding for a file and exits 1 on warnings", async () => {
    const r = await run(["lint", file("bad.txt", "User-agent: *\nDissallow: /a\nCrawl-delay: 2\n")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^L1 +info +empty-group /m);
    expect(r.out).toMatch(/^L2 +warning +unknown-field +Unknown field "Dissallow".*Did you mean Disallow\?/m);
    expect(r.out).toContain("0 error(s), 1 warning(s), 2 info");
    expect(r.calls).toHaveLength(0);
  });
  it("exits 0 for a clean file, and for info-only findings", async () => {
    const clean = await run(["lint", file("ok.txt", "User-agent: *\nDisallow: /admin/\n")]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("No issues found");
    expect((await run(["lint", file("info.txt", "User-agent: *\nDisallow: /a\nCrawl-delay: 1\n")])).code).toBe(0);
  });
  it("--fail-on error ignores warnings but not errors", async () => {
    const warn = file("w.txt", "User-agent: *\nDisallow: admin\n");
    expect((await run(["lint", warn, "--fail-on", "error"])).code).toBe(0);
    expect((await run(["lint", warn])).code).toBe(1);
    expect((await run(["lint", file("h.txt", "<html></html>"), "--fail-on", "error"])).code).toBe(1);
    const bad = await run(["lint", warn, "--fail-on", "info"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("error or warning");
  });
  it("reads stdin for -", async () => {
    const r = await run(["lint", "-", "--json"], {}, "Disallow: /x\n");
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ source: "stdin", failed: true, counts: { warning: 1 } });
    expect(j.findings[0].code).toBe("rule-before-user-agent");
  });
  it("fetches <origin>/robots.txt for a URL", async () => {
    const r = await run(["lint", "https://a.com/page"], { "https://a.com/robots.txt": { body: "User-agent: *\nDisallow: /a\n", headers: txt } });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.url)).toEqual(["https://a.com/robots.txt"]);
    const missing = await run(["lint", "https://a.com/"], { "https://a.com/robots.txt": { status: 404, headers: txt } });
    expect(missing.code).toBe(0);
    expect(missing.out).toContain("No robots.txt (HTTP 404)");
  });
  it("2 on usage errors, unreachable robots.txt and private targets", async () => {
    expect((await run(["lint"])).code).toBe(2);
    expect((await run(["lint", "a", "b"])).code).toBe(2);
    expect((await run(["lint", "https://a.com/", "--nope"])).code).toBe(2);
    const down = await run(["lint", "https://a.com/"], { "https://a.com/robots.txt": { status: 503, headers: txt } });
    expect(down.code).toBe(2);
    expect(down.err).toContain("HTTP 503");
    const out: string[] = [];
    expect(await main(["lint", "http://127.0.0.1/"], { out: (s) => out.push(s), err: (s) => out.push(s) })).toBe(2);
  });
  it("is listed in --help", async () => {
    expect((await run(["lint", "--help"])).out).toContain("lint <url|file|->");
  });
});

describe("scan command", () => {
  const robots = "User-agent: GPTBot\nDisallow: /private/\nSitemap: https://a.com/sm.xml\n";
  const routes = (locs: string[]) => ({
    "https://a.com/robots.txt": { body: robots, headers: txt },
    "https://a.com/sm.xml": { body: `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`, headers: { "content-type": "application/xml" } },
  });
  const pages = ["https://a.com/", "https://a.com/private/a", "https://a.com/private/b"];
  it("prints a per-bot summary and the blocked URLs, exit 0 without --fail-on", async () => {
    const r = await run(["scan", "https://a.com/", "--bots", "GPTBot,ClaudeBot"], routes(pages));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/GPTBot +2 of 3/);
    expect(r.out).toMatch(/ClaudeBot +0 of 3/);
    expect(r.out).toContain("GPTBot: blocked from\n  https://a.com/private/a\n  https://a.com/private/b");
    expect(r.calls.map((c) => c.url)).toEqual(["https://a.com/robots.txt", "https://a.com/sm.xml"]);
  });
  it("caps the printed list at 10 URLs per bot", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `https://a.com/private/${i}`);
    const r = await run(["scan", "https://a.com/", "--bots", "GPTBot", "--limit", "50"], routes(many));
    expect(r.out.match(/^ {2}https:\/\/a\.com\/private\//gm)).toHaveLength(10);
    expect(r.out).toContain("... and 4 more");
  });
  it("--fail-on blocked exits 1 when any bot is blocked, 0 when none", async () => {
    const hit = await run(["scan", "https://a.com/", "--bots", "GPTBot", "--fail-on", "blocked"], routes(pages));
    expect(hit.code).toBe(1);
    expect(hit.err).toContain("GPTBot");
    expect((await run(["scan", "https://a.com/", "--bots", "ClaudeBot", "--fail-on", "blocked"], routes(pages))).code).toBe(0);
  });
  it("--json carries the report, failOn and failed", async () => {
    const j = JSON.parse((await run(["scan", "https://a.com/", "--bots", "GPTBot", "--json", "--fail-on", "blocked"], routes(pages))).out);
    expect(j).toMatchObject({ site: "https://a.com", failOn: "blocked", failed: ["GPTBot"], summary: { urlsChecked: 3 } });
  });
  it("2 when the sitemap yields no URLs, on bad options and private targets", async () => {
    const empty = await run(["scan", "https://a.com/"], routes([]));
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("No URLs found");
    for (const args of [["scan"], ["scan", "https://a.com/", "--limit", "0"], ["scan", "https://a.com/", "--limit", "201"], ["scan", "https://a.com/", "--limit", "x"], ["scan", "https://a.com/", "--fail-on", "any-non-200"], ["scan", "https://a.com/", "--bots", "NopeBot"], ["scan", "https://a.com/", "--delay", "5"], ["scan", "http://127.0.0.1/"]]) {
      expect((await run(args, routes(pages))).code, args.join(" ")).toBe(2);
    }
  });
  it("passes --limit on", async () => {
    const r = await run(["scan", "https://a.com/", "--bots", "GPTBot", "--limit", "2", "--json"], routes(pages));
    expect(JSON.parse(r.out).urls).toHaveLength(2);
  });
});

describe("check --markdown and --summary-file", () => {
  const routes = {
    "https://a.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /some/\n", headers: txt },
    "https://a.com/": { body: "<title>Home</title>" },
  };
  const args = ["check", "https://a.com/", "--bots", "GPTBot,ClaudeBot,CCBot", "--delay", "0"];
  it("prints a Markdown table with a heading and a summary line", async () => {
    const r = await run([...args, "--markdown", "--fail-on", "blocked"], routes);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^## AI crawler access: https:\/\/a\.com\/$/m);
    expect(r.out).toContain("❌ 1 of 3 bot(s) blocked or failing: GPTBot");
    expect(r.out).toContain("| Bot | robots.txt | HTTP | Result |\n| --- | --- | --- | --- |");
    expect(r.out).toContain("| GPTBot | blocked | 200 | ❌ fail |");
    expect(r.out).toContain("| ClaudeBot | allowed | 200 | ✅ ok |");
    expect(r.out).toContain("| CCBot | allowed\\* | 200 | ✅ ok |");
    expect(r.out).toContain("\\* allowed for this path");
  });
  it("marks a blocked bot even when no --fail-on policy is set, and shows a green line when all is open", async () => {
    const r = await run([...args, "--markdown"], routes);
    expect(r.code).toBe(0);
    expect(r.out).toContain("| GPTBot | blocked | 200 | ❌ blocked |");
    const ok = await run(["check", "https://a.com/", "--bots", "ClaudeBot", "--markdown", "--delay", "0"], routes);
    expect(ok.out).toContain("✅ No checked bot is blocked (1 bots).");
  });
  it("rejects --markdown together with --json before any request", async () => {
    const r = await run([...args, "--markdown", "--json"], routes);
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot be combined");
    expect(r.calls).toHaveLength(0);
  });
  it("appends the Markdown to --summary-file and keeps the normal output", async () => {
    const p = join(dir, "summary.md");
    writeFileSync(p, "existing\n");
    const r = await run([...args, "--json", "--summary-file", p, "--fail-on", "blocked"], routes);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).failed).toEqual(["GPTBot"]);
    const written = readFileSync(p, "utf8");
    expect(written.startsWith("existing\n## AI crawler access: https://a.com/")).toBe(true);
    expect(written).toContain("| GPTBot | blocked | 200 | ❌ fail |");
    expect((await run([...args, "--summary-file"], routes)).code).toBe(2);
  });
  it("escapes Markdown control characters from the URL", async () => {
    const r = await run(["check", "https://a.com/?q=a|b`c", "--bots", "ClaudeBot", "--markdown", "--no-http"], { "https://a.com/robots.txt": { status: 404, headers: txt } });
    expect(r.out).toContain("a\\|b\\`c");
  });
});
