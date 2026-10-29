import { describe, expect, it } from "vitest";
import { lintCounts, lintFails, lintRobotsTxt, lintRobotsUrl } from "../src/lint.js";
import { mockFetch, publicResolve } from "./helpers.js";

const codes = (t: string) => lintRobotsTxt(t).map((f) => f.code);
const find = (t: string, code: string) => lintRobotsTxt(t).find((f) => f.code === code);

describe("lintRobotsTxt", () => {
  it("has no findings for a clean file", () => {
    expect(lintRobotsTxt("User-agent: *\nDisallow: /admin/\nAllow: /\n\nSitemap: https://a.com/sitemap.xml\n")).toEqual([]);
    expect(lintRobotsTxt("")).toEqual([]);
  });
  it("flags an HTML page and stops", () => {
    for (const t of ["<!doctype html><html><body>404</body></html>", "  \n<p>nope</p>", "Not found <HTML>"]) expect(lintRobotsTxt(t).map((f) => f.code)).toEqual(["html-instead-of-robots"]);
    expect(find("<html>", "html-instead-of-robots")?.severity).toBe("error");
  });
  it("flags rules before any User-agent line, with the line number", () => {
    const f = find("Disallow: /x\nUser-agent: *\nDisallow: /y\n", "rule-before-user-agent");
    expect(f).toMatchObject({ line: 1, severity: "warning" });
  });
  it("suggests the known field for typos", () => {
    expect(find("User-agent: *\nDissallow: /a\n", "unknown-field")).toMatchObject({ line: 2, message: expect.stringContaining("Did you mean Disallow?") });
    expect(find("Useragent: *\n", "unknown-field")?.message).toContain("Did you mean User-agent?");
    expect(find("User agent: *\n", "unknown-field")?.message).toContain("Did you mean User-agent?");
    const far = find("Frobnicate: yes\n", "unknown-field");
    expect(far?.message).not.toContain("Did you mean");
  });
  it("reports lines without a colon, but not comments or blank lines", () => {
    const f = lintRobotsTxt("# comment\n\nUser-agent: *\nDisallow /admin\nsomething\n");
    expect(f.filter((x) => x.code === "missing-colon").map((x) => x.line)).toEqual([4, 5]);
    expect(f.find((x) => x.line === 4)?.message).toContain('Did you mean "Disallow: ..."');
  });
  it("lists unsupported directives as info", () => {
    const f = lintRobotsTxt("User-agent: *\nCrawl-delay: 5\nNoindex: /a\nHost: a.com\nClean-param: x\nDisallow:\n").filter((x) => x.code === "unsupported-directive");
    expect(f.map((x) => x.line)).toEqual([2, 3, 4, 5]);
    expect(f.every((x) => x.severity === "info")).toBe(true);
    expect(f[0].message).toContain("Google ignores it");
  });
  it("checks that paths start with / or *", () => {
    const f = lintRobotsTxt("User-agent: *\nDisallow: admin\nDisallow: *.pdf$\nDisallow: /ok\nAllow:\nDisallow: https://a.com/x\n").filter((x) => x.code === "path-not-absolute");
    expect(f.map((x) => x.line)).toEqual([2, 6]);
  });
  it("checks that sitemaps are absolute http(s) URLs", () => {
    const f = lintRobotsTxt("Sitemap: /sitemap.xml\nSitemap: ftp://a.com/s.xml\nSitemap:\nSitemap: https://a.com/s.xml\n").filter((x) => x.code === "sitemap-not-absolute");
    expect(f.map((x) => x.line)).toEqual([1, 2, 3]);
  });
  it("suggests catalogue tokens for near misses and names the legacy Anthropic tokens", () => {
    const f = lintRobotsTxt("User-agent: GPTBott\nDisallow: /\nUser-agent: claudebot\nDisallow: /\nUser-agent: anthropic-ai\nDisallow: /\nUser-agent: Claude-Web\nDisallow: /\nUser-agent: SomeRandomCrawler\nDisallow: /\nUser-agent: *\nDisallow: /a\n").filter((x) => x.code === "unknown-agent");
    expect(f.map((x) => x.line)).toEqual([1, 5, 7]);
    expect(f[0].message).toContain("Did you mean GPTBot?");
    expect(f[1].message).toMatch(/ClaudeBot, Claude-User and Claude-SearchBot/);
    expect(f[1].message).toContain("support.claude.com");
    expect(f.every((x) => x.severity === "info")).toBe(true);
  });
  it("does not call other real crawlers typos", () => {
    expect(codes("User-agent: dotbot\nDisallow: /\nUser-agent: xAI-SearchBot\nDisallow: /\n")).not.toContain("unknown-agent");
  });
  it("reports empty groups but treats consecutive User-agent lines as one group", () => {
    expect(codes("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n")).not.toContain("empty-group");
    expect(codes("User-agent: GPTBot\nSitemap: https://a.com/s.xml\nUser-agent: ClaudeBot\nDisallow: /\n")).not.toContain("empty-group");
    expect(find("User-agent: *\nDisallow: /a\nUser-agent: GPTBot\nCrawl-delay: 1\n", "empty-group")).toMatchObject({ line: 3, severity: "info" });
    expect(codes("User-agent: GPTBot\nDisallow:\n")).not.toContain("empty-group"); // explicit allow-all
  });
  it("reports a repeated token once, at the second group", () => {
    const t = "User-agent: GPTBot\nDisallow: /a\nUser-agent: gptbot\nDisallow: /b\nUser-agent: GPTBot\nDisallow: /c\n";
    const f = lintRobotsTxt(t).filter((x) => x.code === "duplicate-agent");
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(3);
    expect(codes("User-agent: GPTBot\nUser-agent: GPTBot\nDisallow: /a\n")).not.toContain("duplicate-agent");
  });
  it("warns when every AI crawler is blocked", () => {
    expect(find("User-agent: *\nDisallow: /\n", "all-ai-blocked")).toMatchObject({ severity: "warning", line: null, message: expect.stringContaining("All 11") });
    expect(codes("User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /\n")).not.toContain("all-ai-blocked");
    expect(codes("User-agent: *\nDisallow: /private/\n")).not.toContain("all-ai-blocked");
  });
  it("warns about files over 500 KiB", () => {
    const big = "User-agent: *\nDisallow: /a\n" + "# pad\n".repeat(100_000);
    expect(codes(big)).toContain("too-large");
    expect(codes("User-agent: *\nDisallow: /a\n")).not.toContain("too-large");
  });
  it("notes lines beyond the parser's cap and caps the number of findings", () => {
    expect(codes("User-agent: *\n" + "Disallow: /a\n".repeat(20_001))).toContain("too-many-lines");
    const f = lintRobotsTxt("Bogus: x\n".repeat(500));
    expect(f).toHaveLength(201);
    expect(f[200].code).toBe("findings-truncated");
  });
  it("sorts findings by line and handles CRLF and a BOM", () => {
    const f = lintRobotsTxt("﻿User-agent: *\r\nDissallow: /a\r\nCrawl-delay: 2\r\n");
    expect(f.map((x) => x.line)).toEqual([1, 2, 3]); // line 1: the group has no valid rule
  });
  it("counts and fail thresholds", () => {
    const f = lintRobotsTxt("Crawl-delay: 1\nBogusfield: x\n");
    expect(lintCounts(f)).toEqual({ error: 0, warning: 1, info: 1 });
    expect(lintFails(f, "warning")).toBe(true);
    expect(lintFails(f, "error")).toBe(false);
    expect(lintFails([], "warning")).toBe(false);
  });
  it("stays fast on hostile input", () => {
    const t0 = Date.now();
    lintRobotsTxt("User-agent: " + "a".repeat(400_000) + "\nDisallow: /\n");
    lintRobotsTxt(("x".repeat(60) + "\n").repeat(8_000));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("lintRobotsUrl", () => {
  const base = { resolve: publicResolve };
  const txt = { "content-type": "text/plain" };
  it("fetches <origin>/robots.txt and lints it", async () => {
    const m = mockFetch({ "https://a.com/robots.txt": { body: "User-agent: *\nDissallow: /a\n", headers: txt } });
    const r = await lintRobotsUrl("https://a.com/some/page?x=1", { ...base, fetch: m.fetch });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].ua).toMatch(/^crawlerpeek\//);
    expect(r).toMatchObject({ url: "https://a.com/robots.txt", status: 200, state: "ok", note: null });
    expect(r.findings.map((f) => f.code)).toEqual(["empty-group", "unknown-field"]);
  });
  it("gives no findings but a note for a 404", async () => {
    const r = await lintRobotsUrl("https://a.com/", { ...base, fetch: mockFetch({ "https://a.com/robots.txt": { status: 404, headers: txt } }).fetch });
    expect(r).toMatchObject({ state: "missing", status: 404, findings: [] });
    expect(r.note).toContain("missing file");
  });
  it("flags an HTML page served as robots.txt", async () => {
    const r = await lintRobotsUrl("https://a.com/", { ...base, fetch: mockFetch({ "https://a.com/robots.txt": { body: "<html><body>Home</body></html>" } }).fetch });
    expect(r.findings.map((f) => f.code)).toEqual(["html-instead-of-robots"]);
  });
  it("treats an HTML error page with a 4xx status as a missing file, not as a broken robots.txt", async () => {
    const r = await lintRobotsUrl("https://a.com/", { ...base, fetch: mockFetch({ "https://a.com/robots.txt": { status: 404, body: "<!doctype html><title>Not found</title>" } }).fetch });
    expect(r).toMatchObject({ state: "missing", status: 404, findings: [] });
  });
  it("reports an unreachable robots.txt without findings and refuses private targets", async () => {
    const r = await lintRobotsUrl("https://a.com/", { ...base, fetch: mockFetch({ "https://a.com/robots.txt": { status: 503, headers: txt } }).fetch });
    expect(r).toMatchObject({ state: "unavailable", error: "HTTP 503", findings: [] });
    await expect(lintRobotsUrl("http://127.0.0.1/")).rejects.toThrow(/private/);
    await expect(lintRobotsUrl("ftp://a.com/")).rejects.toThrow(/http/);
  });
});
