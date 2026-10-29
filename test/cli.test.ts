import { mkdtempSync, writeFileSync } from "node:fs";
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
