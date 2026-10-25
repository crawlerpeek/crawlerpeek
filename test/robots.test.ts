import { describe, expect, it } from "vitest";
import { botRobots, evaluateToken, isAllowed, matchLen, normalizePath, parseRobots, rulesFor } from "../src/robots.js";
import { generateRobotsTxt } from "../src/robotsgen.js";
import { parseRobots as parse2 } from "../src/index.js";

const decide = (txt: string, token: string, path = "/") => botRobots("ok", parseRobots(txt), token, path);

describe("robots.txt evaluation", () => {
  it("a Sitemap line between User-agent lines does not split the group", () => {
    const p = parseRobots("User-agent: GPTBot\nSitemap: https://x.test/sitemap.xml\nUser-agent: ClaudeBot\nDisallow: /\n");
    expect(evaluateToken(p, "GPTBot").status).toBe(evaluateToken(p, "ClaudeBot").status);
    expect(p.sitemaps).toEqual(["https://x.test/sitemap.xml"]);
  });
  it("matches wildcards and end anchors", () => {
    expect(matchLen("/a/*/c", "/a/b/c")).toBeGreaterThan(0);
    expect(matchLen("/*.pdf$", "/x/file.pdf")).toBeGreaterThan(0);
    expect(matchLen("/*.pdf$", "/x/file.pdf?x=1")).toBe(-1);
    expect(matchLen("/private", "/public")).toBe(-1);
  });
  it("longest match wins and Allow wins a tie", () => {
    const p = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\n");
    const rules = rulesFor(p, "GPTBot").rules;
    expect(isAllowed(rules, "/docs/secret")).toBe(false);
    expect(isAllowed(rules, "/docs/public/a")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /x\nAllow: /x\n").groups[0].rules, "/x")).toBe(true);
  });
  it("a bot with its own group ignores the * group", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n";
    expect(decide(txt, "GPTBot").access).toBe("allowed");
    expect(decide(txt, "ClaudeBot").access).toBe("blocked");
    expect(decide(txt, "gptbot").matchedGroup).toBe("gptbot");
  });
  it("shares one group across consecutive user-agent lines and merges repeated groups", () => {
    const txt = "User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: CCBot\nAllow: /open\n";
    expect(decide(txt, "GPTBot", "/page").pathAllowed).toBe(false);
    expect(decide(txt, "CCBot", "/open/x").pathAllowed).toBe(true);
    expect(decide(txt, "CCBot", "/other").pathAllowed).toBe(false);
  });
  it("distinguishes blocked, partial and allowed", () => {
    expect(decide("User-agent: *\nDisallow: /\n", "GPTBot").access).toBe("blocked");
    expect(decide("User-agent: *\nDisallow: /admin/\n", "GPTBot").access).toBe("allowed");
    expect(decide("User-agent: *\nDisallow: /blog/\n", "GPTBot", "/blog/post").access).toBe("blocked");
    expect(decide("User-agent: *\nDisallow: /\nAllow: /public/\n", "GPTBot", "/public/a")).toMatchObject({ access: "partial", pathAllowed: true });
    expect(decide("User-agent: *\nDisallow:\n", "GPTBot").access).toBe("allowed");
  });
  it("handles missing and unavailable robots.txt", () => {
    expect(botRobots("missing", null, "GPTBot", "/").access).toBe("allowed");
    expect(botRobots("unavailable", null, "GPTBot", "/")).toMatchObject({ access: "unknown", pathAllowed: null });
  });
  it("ignores comments, BOM and unknown fields", () => {
    expect(decide("﻿User-agent: GPTBot # hi\nCrawl-delay: 5\nDisallow: / # all\n", "GPTBot").access).toBe("blocked");
    expect(parse2("Sitemap: https://a.com/s.xml").sitemaps).toEqual(["https://a.com/s.xml"]);
  });
  it("survives a hostile pattern without blocking anything", () => {
    const txt = "User-agent: *\nDisallow: " + "*a".repeat(90) + "b\n";
    const t0 = Date.now();
    expect(decide(txt, "GPTBot", "/" + "a".repeat(250)).access).not.toBe("blocked");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("generateRobotsTxt", () => {
  it("welcomes AI bots and repeats disallowed paths in the bot group", () => {
    const t = generateRobotsTxt({ disallow: ["/admin/"], sitemap: "https://example.com/sitemap.xml" });
    expect(t).toContain("User-agent: GPTBot");
    expect(t).toContain("User-agent: Google-Extended");
    const p = parseRobots(t);
    expect(botRobots("ok", p, "ClaudeBot", "/blog").pathAllowed).toBe(true);
    expect(botRobots("ok", p, "ClaudeBot", "/admin/x").pathAllowed).toBe(false);
    expect(botRobots("ok", p, "SomeOther", "/admin/x").pathAllowed).toBe(false);
    expect(p.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
  it("can close specific bots and rejects bad input", () => {
    const p = parseRobots(generateRobotsTxt({ blockBots: ["ccbot"] }));
    expect(botRobots("ok", p, "CCBot", "/").access).toBe("blocked");
    expect(botRobots("ok", p, "GPTBot", "/").access).toBe("allowed");
    expect(() => generateRobotsTxt({ disallow: ["admin"] })).toThrow();
    expect(() => generateRobotsTxt({ disallow: ["/a\nUser-agent: x"] })).toThrow();
    expect(() => generateRobotsTxt({ blockBots: ["NoSuchBot"] })).toThrow(/Unknown bot/);
    expect(() => generateRobotsTxt({ sitemap: "javascript:alert(1)" })).toThrow();
  });
});

describe("percent-encoding normalization (RFC 9309 section 2.2.2)", () => {
  it("normalizes non-ASCII, hex case and unreserved characters", () => {
    expect(normalizePath("/ü")).toBe("/%C3%BC");
    expect(normalizePath("/%c3%bc")).toBe("/%C3%BC");
    expect(normalizePath("/%7Efoo/%41%2f")).toBe("/~foo/A%2F");
    expect(normalizePath("/😀*$")).toBe("/%F0%9F%98%80*$");
    expect(normalizePath("/100%/%zz")).toBe("/100%/%zz");
    expect(normalizePath("/\ud800x")).toBe("/%EF%BF%BDx");
  });
  it("matches a non-ASCII rule against the encoded request path", () => {
    const path = new URL("https://x.test/ü/seite").pathname;
    expect(decide("User-agent: *\nDisallow: /ü\n", "GPTBot", path).pathAllowed).toBe(false);
    expect(decide("User-agent: *\nDisallow: /%c3%bc\n", "GPTBot", "/ü/seite").pathAllowed).toBe(false);
  });
  it("treats %7E and ~ as the same character in either direction", () => {
    expect(decide("User-agent: *\nDisallow: /%7Efoo\n", "GPTBot", "/~foo").pathAllowed).toBe(false);
    expect(decide("User-agent: *\nDisallow: /~foo\n", "GPTBot", "/%7Efoo").pathAllowed).toBe(false);
    expect(decide("User-agent: *\nDisallow: /%7Efoo\n", "GPTBot", "/foo").pathAllowed).toBe(true);
  });
  it("keeps reserved escapes distinct", () => {
    expect(decide("User-agent: *\nDisallow: /a%2Fb\n", "GPTBot", "/a/b").pathAllowed).toBe(true);
    expect(decide("User-agent: *\nDisallow: /a%2Fb\n", "GPTBot", "/a%2fb").pathAllowed).toBe(false);
  });

  it("honors long non-ASCII rules by their written length", () => {
    const rule = "/" + "日".repeat(60);
    const p = parseRobots(`User-agent: *\nDisallow: ${rule}\n`);
    expect(isAllowed(p.groups[0].rules, normalizePath(rule + "/x"))).toBe(false);
    expect(matchLen(normalizePath("/" + "ü".repeat(101)), normalizePath("/" + "ü".repeat(101)))).toBe(-1);
  });
});
