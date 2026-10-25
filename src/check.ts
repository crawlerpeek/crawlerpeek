import { BOTS, DEFAULT_BOT_TOKENS, type Bot } from "./bots.js";
import { botRobots, parseRobots, type Access, type Parsed, type RobotsState } from "./robots.js";
import { guardedGet, NetError, type Fetched, type NetOptions } from "./net.js";
import { VERSION } from "./version.js";

/** Used for robots.txt: an honest, identifiable client. seeAsBot is different, see its doc comment. */
export const CLIENT_UA = `crawlerpeek/${VERSION} (+https://crawlerpeek.com)`;

export type CheckOptions = {
  /** Tokens or slugs (case-insensitive), or "all". Default: the 15 bots in DEFAULT_BOT_TOKENS. */
  bots?: string[] | "all";
  /** Also fetch the page once per bot with that bot's user agent. Default true. */
  http?: boolean;
  /** Pause between the per-bot requests in ms. Default 300. */
  delayMs?: number;
  allowPrivate?: boolean;
  resolve?: NetOptions["resolve"];
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type HttpOutcome = "ok" | "blocked" | "error";

export type SeeAsBotResult = {
  bot: string;
  url: string;
  /** Request completed (any HTTP status). false when the connection failed; see `error`. */
  fetched: boolean;
  status: number | null;
  finalUrl: string | null;
  redirects: number;
  contentType: string;
  bytes: number;
  /** Body was cut at the 2 MB cap. */
  truncated: boolean;
  title: string;
  /** The response looks like a deliberate block or bot challenge, not a normal page. */
  looksBlocked: boolean;
  blockReason: string | null;
  outcome: HttpOutcome;
  error: string | null;
};

export type BotCheck = {
  bot: string;
  owner: string;
  kind: Bot["kind"];
  robots: { access: Access | "unknown"; pathAllowed: boolean | null; matchedGroup: string };
  /** null when not fetched (http:false) or the token never makes requests (control tokens). */
  http: SeeAsBotResult | null;
};

export type CheckReport = {
  url: string;
  checkedAt: string;
  path: string;
  /** `error` says why the state is "unavailable" (timeout, HTTP 5xx, refused redirect), else null. */
  robotsTxt: { url: string; state: RobotsState; status: number | null; error: string | null; sitemaps: string[] };
  bots: BotCheck[];
};

const norm = (s: string) => s.trim().toLowerCase();

export function findBot(nameOrSlug: string): Bot | undefined {
  const n = norm(nameOrSlug);
  return BOTS.find((b) => norm(b.token) === n || b.slug === n);
}

/** Resolves a user-supplied list to catalogue bots. Throws on unknown names (message lists the valid ones). */
export function selectBots(list?: string[] | "all"): Bot[] {
  if (list === "all") return [...BOTS];
  const names = list && list.length ? list : DEFAULT_BOT_TOKENS;
  const out: Bot[] = [];
  for (const n of names) {
    const b = findBot(n);
    if (!b) throw new Error(`Unknown bot "${n}". Known: ${BOTS.map((x) => x.token).join(", ")}.`);
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

const CHALLENGE_BODY = /cf-chl|just a moment\.\.\.|attention required! \| cloudflare|captcha-delivery|_incapsula_|access denied|enable javascript and cookies/i;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Text of the first `<title>` element. Linear scan with indexOf, no regular expression over the (untrusted) page. */
export function extractTitle(html: string): string {
  const s = html.slice(0, 600_000);
  const lower = s.replace(/[A-Z]+/g, (c) => c.toLowerCase()); // ASCII only, keeps indices aligned
  let from = 0;
  let inner = "";
  for (;;) {
    const i = lower.indexOf("<title", from);
    if (i < 0) return "";
    from = i + 6;
    if (!/[\s>/]/.test(lower[from] ?? "")) continue; // <titlex>, <title<...
    const open = lower.indexOf(">", from);
    if (open < 0) return "";
    const close = lower.indexOf("</title", open);
    if (close < 0) return "";
    inner = s.slice(open + 1, close);
    break;
  }
  const text = inner.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
  return clean(text, 200);
}

/** A deliberate block or bot challenge, as opposed to a transient error. */
export function detectBlock(f: Pick<Fetched, "status" | "headers" | "body">): string | null {
  if ([401, 403, 406, 451].includes(f.status)) return `HTTP ${f.status}`;
  if ((f.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") return "Cloudflare challenge (cf-mitigated header)";
  if (f.body.length < 30_000 && CHALLENGE_BODY.test(f.body)) return "challenge or access-denied page";
  return null;
}

/**
 * Fetches `url` once with the bot's own user-agent string, from this machine, and reports what came back. It does NOT prove what the
 * real bot would get: operators such as Google and OpenAI publish IP ranges, and a site may treat a request that claims to be that bot
 * but comes from another IP differently (often blocking it as fake). The request is not an official crawl and does not execute scripts.
 */
export async function seeAsBot(url: string, bot: string | Bot, opts: CheckOptions = {}): Promise<SeeAsBotResult> {
  const b = typeof bot === "string" ? findBot(bot) : bot;
  if (!b) throw new Error(`Unknown bot "${String(bot)}". Known: ${BOTS.map((x) => x.token).join(", ")}.`);
  if (!b.ua) throw new Error(`${b.token} is a robots.txt control token, not a crawler: it never requests pages, so there is nothing to fetch.`);
  const base: SeeAsBotResult = { bot: b.token, url, fetched: false, status: null, finalUrl: null, redirects: 0, contentType: "", bytes: 0, truncated: false, title: "", looksBlocked: false, blockReason: null, outcome: "error", error: null };
  try {
    const f = await guardedGet(url, { userAgent: b.ua, allowPrivate: opts.allowPrivate, resolve: opts.resolve, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
    const reason = detectBlock(f);
    const isHtml = /html/i.test(f.contentType) || /^\s*<(!doctype|html|head|body)/i.test(f.body);
    return {
      ...base, fetched: true, status: f.status, finalUrl: f.finalUrl, redirects: f.redirects, contentType: clean(f.contentType, 100), bytes: f.bytes, truncated: f.truncated,
      title: isHtml ? extractTitle(f.body) : "", looksBlocked: reason !== null, blockReason: reason,
      outcome: reason ? "blocked" : f.status >= 200 && f.status < 300 ? "ok" : "error",
    };
  } catch (e) {
    if (isInputError(e)) throw e;
    return { ...base, error: e instanceof Error ? clean(e.message, 200) : "request failed" };
  }
}

/** Only the user-supplied URL may abort a run; a redirect to a refused target is reported per bot instead. */
const isInputError = (e: unknown) => e instanceof NetError && (e.code === "blocked" || e.code === "invalid_url") && !e.redirect;

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * For each bot: does robots.txt allow the URL's path, and (unless http:false) what does the page return when fetched with that bot's
 * user agent. One robots.txt request plus at most one page request per bot, sequential, with a short pause.
 */
export async function checkAiAccess(url: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const bots = selectBots(opts.bots);
  const net: NetOptions = { userAgent: CLIENT_UA, accept: "text/plain,*/*;q=0.5", allowPrivate: opts.allowPrivate, resolve: opts.resolve, fetch: opts.fetch, timeoutMs: opts.timeoutMs, maxBytes: 512_000 };
  let target: URL;
  try { target = new URL(url); } catch { throw new NetError("invalid_url", `Not a valid URL: ${url.slice(0, 200)}`); }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new NetError("invalid_url", "Only http and https URLs are supported.");
  const robotsUrl = `${target.origin}/robots.txt`;
  let state: RobotsState = "unavailable";
  let parsed: Parsed | null = null;
  let status: number | null = null;
  let robotsError: string | null = null;
  try {
    const r = await guardedGet(robotsUrl, net);
    status = r.status;
    const html = /html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.body);
    if (r.status >= 500 || r.status === 429) { state = "unavailable"; robotsError = `HTTP ${r.status}`; }
    else if (r.status >= 300 && r.status < 400) { state = "unavailable"; robotsError = `HTTP ${r.status} without a Location header`; }
    else if (r.status >= 400 || html) state = "missing";
    else { state = "ok"; parsed = parseRobots(r.body); }
  } catch (e) {
    if (isInputError(e)) throw e;
    robotsError = e instanceof Error ? clean(e.message, 200) : "request failed";
  }
  const path = (target.pathname || "/") + target.search;
  const out: BotCheck[] = [];
  let first = true;
  for (const b of bots) {
    const rb = botRobots(state, parsed, b.token, path);
    let http: SeeAsBotResult | null = null;
    if ((opts.http ?? true) && b.ua) {
      if (!first) await sleep(opts.delayMs ?? 300);
      first = false;
      http = await seeAsBot(url, b, opts);
    }
    out.push({ bot: b.token, owner: b.owner, kind: b.kind, robots: { access: rb.access, pathAllowed: rb.pathAllowed, matchedGroup: rb.matchedGroup }, http });
  }
  return {
    url, checkedAt: new Date().toISOString(), path,
    robotsTxt: { url: robotsUrl, state, status, error: robotsError, sitemaps: parsed?.sitemaps.slice(0, 20) ?? [] },
    bots: out,
  };
}

export type FailOn = "none" | "blocked" | "any-non-200";

/** Bots that make the run fail under the given policy. `blocked`: robots.txt closes the path, or the page answers with a block/challenge. `any-non-200`: additionally any other status or failed request. Unknown robots state never fails. */
export function failingBots(report: CheckReport, failOn: FailOn): string[] {
  if (failOn === "none") return [];
  return report.bots.filter((b) => {
    if (b.robots.pathAllowed === false) return true;
    if (!b.http) return false;
    if (b.http.outcome === "blocked") return true;
    return failOn === "any-non-200" && b.http.status !== 200;
  }).map((b) => b.bot);
}
