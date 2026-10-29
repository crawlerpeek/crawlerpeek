import { CLIENT_UA, fetchRobots, selectBots, type CheckOptions, type CheckReport } from "./check.js";
import { guardedGet, NetError, type NetOptions } from "./net.js";
import { isAllowed, LIMITS, normalizePath, rulesFor, type Budget } from "./robots.js";

/**
 * Evaluates robots.txt for many URLs of one site, taken from its sitemap. Polite by design: no page is fetched, the only requests are
 * robots.txt and at most 10 sitemap files (5 listed in robots.txt or the default /sitemap.xml, 5 children of a sitemap index).
 * Sitemaps are untrusted input: indexOf scanning instead of regular expressions, 5 MB and 50 000 entry caps.
 */
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
export const SITEMAP_MAX_LOCS = 50_000;
export const SCAN_DEFAULT_LIMIT = 25;
export const SCAN_MAX_LIMIT = 200;
const MAX_TOP = 5;
const MAX_CHILDREN = 5;
const MAX_LOC = 2048;

export type ScanOptions = Pick<CheckOptions, "bots" | "allowPrivate" | "resolve" | "fetch" | "timeoutMs"> & { /** 1 to 200, default 25. */ limit?: number };
export type SitemapInfo = { url: string; status: number | null; /** URLs found in this file (sitemap index: child sitemaps). */ urls: number; error: string | null };
export type ScanReport = {
  site: string;
  checkedAt: string;
  robotsTxt: CheckReport["robotsTxt"];
  sitemaps: SitemapInfo[];
  urls: { url: string; blockedFor: string[] }[];
  summary: { urlsChecked: number; perBot: { bot: string; blocked: number; /** The step budget ran out; blocked is a lower bound. */ undecided?: true }[] };
};

const ENTITY = /&(amp|lt|gt|quot|apos);/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(ENTITY, (_, e: string) => ENTITIES[e]);

/** Text of every `<loc>` element, entity-decoded; `index` is true for a sitemap index. */
export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const locs: string[] = [];
  const index = xml.indexOf("<sitemapindex") >= 0;
  let from = 0;
  while (locs.length < SITEMAP_MAX_LOCS) {
    const open = xml.indexOf("<loc>", from);
    if (open < 0) break;
    const close = xml.indexOf("</loc>", open + 5);
    if (close < 0) break;
    from = close + 6;
    let v = xml.slice(open + 5, close).trim();
    if (v.startsWith("<![CDATA[") && v.endsWith("]]>")) v = v.slice(9, -3).trim();
    if (v.length && v.length <= MAX_LOC) locs.push(decode(v));
  }
  return { index, locs };
}

const isGzip = (url: string) => { try { return new URL(url).pathname.toLowerCase().endsWith(".gz"); } catch { return false; } };

export async function scanSite(url: string, opts: ScanOptions = {}): Promise<ScanReport> {
  const limit = opts.limit ?? SCAN_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SCAN_MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${SCAN_MAX_LIMIT}.`);
  const bots = selectBots(opts.bots);
  const rf = await fetchRobots(url, opts);
  // A robots.txt that redirects to another host (example.com -> www.example.com) is that host's file too, and its sitemap lists that host's URLs.
  const hosts = new Set([rf.target.host]);
  if (rf.finalUrl) hosts.add(new URL(rf.finalUrl).host);
  const net: NetOptions = { userAgent: CLIENT_UA, accept: "application/xml,text/xml,text/plain;q=0.8,*/*;q=0.5", allowPrivate: opts.allowPrivate, resolve: opts.resolve, fetch: opts.fetch, timeoutMs: opts.timeoutMs, maxBytes: SITEMAP_MAX_BYTES };

  const sitemaps: SitemapInfo[] = [];
  const found = new Set<string>();
  const sameHost = (raw: string): string | null => {
    try { const u = new URL(raw); return (u.protocol === "http:" || u.protocol === "https:") && hosts.has(u.host) ? u.href : null; } catch { return null; }
  };
  /** One sitemap file; returns its entries (URLs, or child sitemaps for an index). */
  async function load(raw: string): Promise<{ index: boolean; locs: string[]; info: SitemapInfo }> {
    const info: SitemapInfo = { url: raw, status: null, urls: 0, error: null };
    sitemaps.push(info);
    const same = sameHost(raw);
    if (!same) { info.error = "not on the scanned host, skipped"; return { index: false, locs: [], info }; }
    if (isGzip(same)) { info.error = "gzip sitemaps are not supported, skipped"; return { index: false, locs: [], info }; }
    try {
      const r = await guardedGet(same, net);
      info.status = r.status;
      if (r.status < 200 || r.status >= 300) { info.error = `HTTP ${r.status}`; return { index: false, locs: [], info }; }
      if (r.body.charCodeAt(0) === 0x1f && r.body.charCodeAt(1) === 0xfffd) { info.error = "gzip sitemaps are not supported, skipped"; return { index: false, locs: [], info }; }
      const p = parseSitemap(r.body);
      info.urls = p.locs.length;
      if (r.truncated) info.error = "larger than 5 MB, read the first 5 MB";
      return { ...p, info };
    } catch (e) {
      if (e instanceof NetError && (e.code === "blocked" || e.code === "invalid_url") && !e.redirect) throw e;
      info.error = e instanceof Error ? e.message.slice(0, 200) : "request failed";
      return { index: false, locs: [], info };
    }
  }

  const tops = rf.parsed?.sitemaps.length ? rf.parsed.sitemaps.slice(0, MAX_TOP) : [`${rf.finalUrl ? new URL(rf.finalUrl).origin : rf.target.origin}/sitemap.xml`];
  let children = 0;
  for (const top of tops) {
    if (found.size >= limit) break;
    const p = await load(top);
    const add = (locs: string[]) => { for (const l of locs) { const u = sameHost(l); if (u) found.add(u); if (found.size >= limit) break; } };
    if (!p.index) { add(p.locs); continue; }
    for (const child of p.locs) {
      if (found.size >= limit || children >= MAX_CHILDREN) break;
      children++;
      const c = await load(child);
      if (c.index) c.info.error = "sitemap index inside a sitemap index, not followed";
      else add(c.locs);
    }
  }

  const list = [...found].slice(0, limit);
  const perBot = bots.map((b) => {
    const decided = rf.state === "ok" && rf.parsed;
    const rules = decided ? rulesFor(rf.parsed!, b.token).rules : [];
    const budget: Budget = { steps: LIMITS.steps, exceeded: false };
    const blocked = list.map((u) => {
      if (!decided || budget.exceeded) return false;
      const t = new URL(u);
      return !isAllowed(rules, normalizePath((t.pathname || "/") + t.search), budget);
    });
    return { bot: b.token, blocked, undecided: budget.exceeded };
  });
  const urls = list.map((u, i) => ({ url: u, blockedFor: perBot.filter((p) => p.blocked[i]).map((p) => p.bot) }));
  return {
    site: rf.target.origin, checkedAt: new Date().toISOString(),
    robotsTxt: { url: rf.robotsUrl, state: rf.state, status: rf.status, error: rf.error, sitemaps: rf.parsed?.sitemaps.slice(0, 20) ?? [] },
    sitemaps, urls,
    summary: { urlsChecked: list.length, perBot: perBot.map((p) => ({ bot: p.bot, blocked: p.blocked.filter(Boolean).length, ...(p.undecided ? { undecided: true as const } : {}) })) },
  };
}
