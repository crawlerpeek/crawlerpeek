import { describe, expect, it } from "vitest";
import { parseSitemap, scanSite } from "../src/scan.js";
import { mockFetch, publicResolve } from "./helpers.js";

const txt = { "content-type": "text/plain" };
const xml = { "content-type": "application/xml" };
const urlset = (...locs: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
const index = (...locs: string[]) => `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
const scan = (routes: Parameters<typeof mockFetch>[0], opts: Parameters<typeof scanSite>[1] = {}, url = "https://a.com/some/page") => {
  const m = mockFetch(routes);
  return scanSite(url, { resolve: publicResolve, fetch: m.fetch, ...opts }).then((r) => ({ r, calls: m.calls.map((c) => c.url) }));
};

describe("parseSitemap", () => {
  it("reads <loc> text, decodes the five XML entities and unwraps CDATA", () => {
    const p = parseSitemap(urlset("https://a.com/?a=1&amp;b=2", "https://a.com/x&lt;y&gt;&quot;&apos;") + "<url><loc><![CDATA[https://a.com/cdata?x=1&y=2]]></loc></url>");
    expect(p.index).toBe(false);
    expect(p.locs).toEqual(["https://a.com/?a=1&b=2", "https://a.com/x<y>\"'", "https://a.com/cdata?x=1&y=2"]);
  });
  it("detects an index, ignores image:loc and truncated tags", () => {
    expect(parseSitemap(index("https://a.com/s1.xml")).index).toBe(true);
    expect(parseSitemap("<url><image:loc>https://a.com/i.jpg</image:loc></url><url><loc>https://a.com/p").locs).toEqual([]);
    expect(parseSitemap("<loc></loc><loc>  </loc>").locs).toEqual([]);
  });
  it("caps the number of entries and the length of one", () => {
    expect(parseSitemap("<loc>https://a.com/x</loc>".repeat(60_000)).locs).toHaveLength(50_000);
    expect(parseSitemap(`<loc>https://a.com/${"a".repeat(3000)}</loc>`).locs).toEqual([]);
  });
  it("is linear on hostile input", () => {
    const t0 = Date.now();
    parseSitemap("<loc>".repeat(500_000));
    parseSitemap("<loc>&amp;".repeat(100_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("scanSite", () => {
  const robots = "User-agent: GPTBot\nDisallow: /private/\n\nUser-agent: *\nDisallow: /tmp/\nSitemap: https://a.com/sm.xml\n";
  it("evaluates every sitemap URL per bot and makes only robots.txt and sitemap requests", async () => {
    const { r, calls } = await scan({
      "https://a.com/robots.txt": { body: robots, headers: txt },
      "https://a.com/sm.xml": { body: urlset("https://a.com/", "https://a.com/private/x", "https://a.com/tmp/y", "https://a.com/blog?a=1&amp;b=2"), headers: xml },
    }, { bots: ["GPTBot", "ClaudeBot"] });
    expect(calls).toEqual(["https://a.com/robots.txt", "https://a.com/sm.xml"]);
    expect(r.site).toBe("https://a.com");
    expect(r.robotsTxt).toMatchObject({ state: "ok", status: 200, sitemaps: ["https://a.com/sm.xml"] });
    expect(r.sitemaps).toEqual([{ url: "https://a.com/sm.xml", status: 200, urls: 4, error: null }]);
    expect(r.urls).toEqual([
      { url: "https://a.com/", blockedFor: [] },
      { url: "https://a.com/private/x", blockedFor: ["GPTBot"] },
      { url: "https://a.com/tmp/y", blockedFor: ["ClaudeBot"] },
      { url: "https://a.com/blog?a=1&b=2", blockedFor: [] },
    ]);
    expect(r.summary).toEqual({ urlsChecked: 4, perBot: [{ bot: "GPTBot", blocked: 1 }, { bot: "ClaudeBot", blocked: 1 }] });
  });
  it("falls back to /sitemap.xml when robots.txt lists none, also without robots.txt", async () => {
    const { r, calls } = await scan({ "https://a.com/robots.txt": { status: 404, headers: txt }, "https://a.com/sitemap.xml": { body: urlset("https://a.com/p"), headers: xml } });
    expect(calls).toEqual(["https://a.com/robots.txt", "https://a.com/sitemap.xml"]);
    expect(r.robotsTxt.state).toBe("missing");
    expect(r.summary.urlsChecked).toBe(1);
    expect(r.summary.perBot.every((b) => b.blocked === 0)).toBe(true);
  });
  it("follows a sitemap index one level deep, at most 5 children", async () => {
    const kids = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://a.com/s${i}.xml`);
    const routes: Parameters<typeof mockFetch>[0] = { "https://a.com/robots.txt": { body: "Sitemap: https://a.com/idx.xml\n", headers: txt }, "https://a.com/idx.xml": { body: index(...kids), headers: xml } };
    kids.forEach((k, i) => { routes[k] = { body: i === 0 ? index("https://a.com/deep.xml") : urlset(`https://a.com/k${i}`), headers: xml }; });
    const { r, calls } = await scan(routes, { limit: 200 });
    expect(calls).toEqual(["https://a.com/robots.txt", "https://a.com/idx.xml", ...kids.slice(0, 5)]);
    expect(r.sitemaps[1].error).toContain("not followed");
    expect(r.urls.map((u) => u.url)).toEqual(["https://a.com/k1", "https://a.com/k2", "https://a.com/k3", "https://a.com/k4"]);
  });
  it("keeps only http(s) URLs on the same host, deduplicated", async () => {
    const { r } = await scan({
      "https://a.com/robots.txt": { status: 404, headers: txt },
      "https://a.com/sitemap.xml": { body: urlset("https://a.com/x", "https://www.a.com/x", "http://a.com/y", "https://b.com/x", "ftp://a.com/z", "javascript:alert(1)", "not a url", "https://a.com/x", "https://a.com:8443/x"), headers: xml },
    });
    expect(r.urls.map((u) => u.url)).toEqual(["https://a.com/x", "http://a.com/y"]);
  });
  it("skips sitemaps on another host without requesting them", async () => {
    const { r, calls } = await scan({ "https://a.com/robots.txt": { body: "Sitemap: https://cdn.b.com/s.xml\n", headers: txt } });
    expect(calls).toEqual(["https://a.com/robots.txt"]);
    expect(r.sitemaps[0].error).toContain("not on the scanned host");
    expect(r.summary.urlsChecked).toBe(0);
  });
  it("reports gzip sitemaps as skipped, by name or by content", async () => {
    const { r, calls } = await scan({
      "https://a.com/robots.txt": { body: "Sitemap: https://a.com/s.xml.gz\nSitemap: https://a.com/s2.xml\n", headers: txt },
      "https://a.com/s2.xml": { body: "\u001f\ufffd\u0008binary" /* how 1f 8b decodes as UTF-8 */, headers: xml },
    });
    expect(calls).toEqual(["https://a.com/robots.txt", "https://a.com/s2.xml"]);
    expect(r.sitemaps.map((s) => s.error)).toEqual(["gzip sitemaps are not supported, skipped", "gzip sitemaps are not supported, skipped"]);
  });
  it("applies the limit and stops requesting once it is reached", async () => {
    const locs = Array.from({ length: 300 }, (_, i) => `https://a.com/p${i}`);
    const routes = { "https://a.com/robots.txt": { body: "Sitemap: https://a.com/s1.xml\nSitemap: https://a.com/s2.xml\n", headers: txt }, "https://a.com/s1.xml": { body: urlset(...locs), headers: xml }, "https://a.com/s2.xml": { body: urlset("https://a.com/other"), headers: xml } };
    const def = await scan(routes);
    expect(def.r.urls).toHaveLength(25);
    expect(def.calls).toEqual(["https://a.com/robots.txt", "https://a.com/s1.xml"]);
    expect((await scan(routes, { limit: 200 })).r.urls).toHaveLength(200);
    for (const limit of [0, 201, 1.5, Number.NaN]) await expect(scan(routes, { limit })).rejects.toThrow(/limit must be/);
  });
  it("reports failing sitemaps without failing the scan", async () => {
    const { r } = await scan({ "https://a.com/robots.txt": { body: "Sitemap: https://a.com/gone.xml\nSitemap: https://a.com/boom.xml\n", headers: txt }, "https://a.com/gone.xml": { status: 404 } });
    expect(r.sitemaps.map((s) => s.error)).toEqual(["HTTP 404", expect.stringContaining("no route")]);
    expect(r.urls).toEqual([]);
  });
  it("treats an unreachable robots.txt as undecided, not blocked", async () => {
    const { r } = await scan({ "https://a.com/robots.txt": { status: 503, headers: txt }, "https://a.com/sitemap.xml": { body: urlset("https://a.com/p"), headers: xml } });
    expect(r.robotsTxt).toMatchObject({ state: "unavailable", error: "HTTP 503" });
    expect(r.urls[0].blockedFor).toEqual([]);
  });
  it("rejects unknown bots and private targets", async () => {
    await expect(scan({}, { bots: ["NopeBot"] })).rejects.toThrow(/Unknown bot/);
    await expect(scanSite("http://127.0.0.1/", { resolve: publicResolve })).rejects.toThrow(/private/);
  });
  it("follows a robots.txt redirect to www and keeps that host's sitemap URLs", async () => {
    const { r, calls } = await scan({
      "https://a.com/robots.txt": { status: 301, headers: { location: "https://www.a.com/robots.txt" } },
      "https://www.a.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /x/\n", headers: txt },
      "https://www.a.com/sitemap.xml": { body: urlset("https://www.a.com/x/1", "https://www.a.com/y", "https://b.com/z"), headers: xml },
    }, {}, "https://a.com/");
    expect(calls).toEqual(["https://a.com/robots.txt", "https://www.a.com/robots.txt", "https://www.a.com/sitemap.xml"]);
    expect(r.urls).toEqual([{ url: "https://www.a.com/x/1", blockedFor: ["GPTBot"] }, { url: "https://www.a.com/y", blockedFor: [] }]);
  });
});
