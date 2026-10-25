import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { BOTS, type Bot } from "./bots.js";
import { guardedGet, type Resolver } from "./net.js";
import { findBot } from "./check.js";
import { VERSION } from "./version.js";

export const LIST_CACHE_TTL_MS = 60 * 60 * 1000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const LIST_TIMEOUT_MS = 10_000;

export type VerifyMethod = "ip-list" | "reverse-dns" | "none";
export type VerifyResult = {
  bot: string;
  method: VerifyMethod;
  /** true = confirmed by the operator's own list or forward-confirmed reverse DNS, false = checked and not confirmed, null = could not be decided. */
  verified: boolean | null;
  detail: string;
  /** The operator's published IP lists, or its documentation page when it publishes no method. */
  source: string | null;
};
export type DnsResolver = {
  reverse: (ip: string) => Promise<string[]>;
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
};
export type VerifyOptions = {
  /** Bot token or slug; omit to check every catalogue bot that publishes a method. */
  bot?: string;
  /** Replaces the built-in HTTP transport (tests). */
  fetch?: typeof fetch;
  /** DNS resolver for the SSRF check of the list hosts (default: system resolver). */
  resolve?: Resolver;
  /** Reverse and forward DNS lookups for the reverse-DNS method (default: node:dns). */
  resolver?: DnsResolver;
};

type Range = [bigint, number];
type Ranges = { v4: Range[]; v6: Range[] };

/** Parses an IPv4 or IPv6 literal to its family and integer value. IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4. */
export function parseIp(raw: string): { family: 4 | 6; value: bigint } | null {
  const s = raw.trim().replace(/^\[|\]$/g, "");
  const kind = isIP(s);
  if (kind === 4) return { family: 4, value: s.split(".").reduce((a, o) => (a << 8n) | BigInt(o), 0n) };
  if (kind !== 6 || s.includes("%")) return null;
  let head = s.toLowerCase();
  const dot = head.lastIndexOf(".");
  if (dot >= 0) {
    const c = head.lastIndexOf(":");
    const q = head.slice(c + 1).split(".").map(Number);
    head = head.slice(0, c + 1) + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  const [a, b = ""] = head.split("::");
  const part = (x: string) => (x ? x.split(":") : []);
  const h = part(a), t = part(b);
  const groups = head.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  const value = groups.reduce((acc: bigint, g: string) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
  return { family: 6, value };
}

function parseCidr(raw: string): { family: 4 | 6; range: Range } | null {
  const [addr, len, extra] = raw.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip || (len !== undefined && !/^\d{1,3}$/.test(len))) return null;
  const max = ip.family === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (bits > max || (ip.family === 4 && addr.includes(":"))) return null;
  return { family: ip.family, range: [ip.value, bits] };
}

/** True when `ip` lies inside the CIDR block (a bare address is a /32 or /128). Invalid input never matches. */
export function inCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip), c = parseCidr(cidr);
  return !!a && !!c && a.family === c.family && covers(c.range, a.value, a.family);
}
function covers([base, bits]: Range, value: bigint, family: 4 | 6): boolean {
  const shift = BigInt((family === 4 ? 32 : 128) - bits);
  return value >> shift === base >> shift;
}

/** Reads the JSON shapes operators publish: `{prefixes:[{ipv4Prefix|ipv6Prefix}]}` and Ahrefs' `{ips:[{ip_address}]}`. */
export function parseIpList(body: string): Ranges {
  const data = JSON.parse(body) as { prefixes?: Record<string, unknown>[]; ips?: Record<string, unknown>[] };
  const out: Ranges = { v4: [], v6: [] };
  const entries = [...(Array.isArray(data.prefixes) ? data.prefixes : []), ...(Array.isArray(data.ips) ? data.ips : [])];
  for (const e of entries) {
    const v = e && typeof e === "object" ? (e.ipv4Prefix ?? e.ipv6Prefix ?? e.ip_address ?? e.ipv4 ?? e.ipv6) : undefined;
    const c = typeof v === "string" ? parseCidr(v) : null;
    if (c) (c.family === 4 ? out.v4 : out.v6).push(c.range);
  }
  if (out.v4.length + out.v6.length === 0) throw new Error("no address ranges found");
  return out;
}

const cache = new Map<string, { at: number; ranges: Ranges }>();
export function clearVerifyCache(): void { cache.clear(); }

async function loadList(url: string, o: VerifyOptions): Promise<Ranges> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) return hit.ranges;
  const r = await guardedGet(url, { userAgent: `crawlerpeek/${VERSION} (+https://crawlerpeek.com)`, accept: "application/json", maxBytes: LIST_MAX_BYTES, timeoutMs: LIST_TIMEOUT_MS, maxRedirects: 0, fetch: o.fetch, resolve: o.resolve });
  if (new URL(r.finalUrl).protocol !== "https:") throw new Error("not https");
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  if (r.truncated) throw new Error("list larger than 2 MB");
  const ranges = parseIpList(r.body);
  cache.set(url, { at: Date.now(), ranges });
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  return ranges;
}

const label = (url: string) => new URL(url).host + new URL(url).pathname;
const defaultResolver: DnsResolver = { reverse: (ip) => dns.reverse(ip), resolve4: (h) => dns.resolve4(h), resolve6: (h) => dns.resolve6(h) };
const noRecord = (e: unknown) => ["ENOTFOUND", "ENODATA"].includes((e as { code?: string })?.code ?? "");

type Step = { verified: boolean | null; detail: string };

async function byList(ip: ReturnType<typeof parseIp> & object, bot: Bot, o: VerifyOptions): Promise<Step> {
  const failed: string[] = [];
  const settled = await Promise.all((bot.ipLists ?? []).map(async (u) => {
    try { return { u, r: await loadList(u, o) }; } catch (e) { failed.push(`${label(u)} (${e instanceof Error ? e.message.slice(0, 100) : "failed"})`); return null; }
  }));
  for (const s of settled) {
    if (s && covers0(s.r, ip)) return { verified: true, detail: `The address is inside ${bot.owner}'s published range list ${label(s.u)}.` };
  }
  if (failed.length) return { verified: null, detail: `Could not read the published IP list${failed.length > 1 ? "s" : ""}: ${failed.join("; ")}.` };
  return { verified: false, detail: `The address is not in ${bot.owner}'s published IP range list${(bot.ipLists?.length ?? 0) > 1 ? "s" : ""}.` };
}
const covers0 = (r: Ranges, ip: { family: 4 | 6; value: bigint }) => (ip.family === 4 ? r.v4 : r.v6).some((x) => covers(x, ip.value, ip.family));

async function byRdns(ipText: string, ip: { family: 4 | 6; value: bigint }, bot: Bot, o: VerifyOptions): Promise<Step> {
  const res = o.resolver ?? defaultResolver;
  const suffixes = bot.rdnsSuffixes ?? [];
  const shown = suffixes.map((s) => "*" + s).join(", ");
  let names: string[];
  try { names = await res.reverse(ipText); } catch (e) {
    return noRecord(e) ? { verified: false, detail: `No reverse DNS record for the address (expected ${shown}).` } : { verified: null, detail: "The reverse DNS lookup failed." };
  }
  const named = names.map((n) => n.toLowerCase().replace(/\.$/, "")).filter((n) => suffixes.some((s) => n.endsWith(s)));
  if (!named.length) return { verified: false, detail: `Reverse DNS is ${names.slice(0, 3).join(", ") || "empty"}, not under ${shown}.` };
  let unsure = false;
  for (const n of named.slice(0, 5)) {
    try {
      const fwd = ip.family === 4 ? await res.resolve4(n) : await res.resolve6(n);
      if (fwd.some((a) => { const p = parseIp(a); return !!p && p.family === ip.family && p.value === ip.value; })) return { verified: true, detail: `Reverse DNS ${n} resolves back to the same address (forward-confirmed).` };
    } catch (e) { if (!noRecord(e)) unsure = true; }
  }
  return unsure ? { verified: null, detail: `Reverse DNS is ${named[0]}, but the forward lookup failed.` } : { verified: false, detail: `Reverse DNS is ${named[0]}, but that name does not resolve back to the address (forward confirmation failed).` };
}

async function verifyOne(ipText: string, ip: { family: 4 | 6; value: bigint }, bot: Bot, o: VerifyOptions): Promise<VerifyResult> {
  const hasList = !!bot.ipLists?.length, hasRdns = !!bot.rdnsSuffixes?.length;
  if (!hasList && !hasRdns) {
    return { bot: bot.token, method: "none", verified: null, detail: bot.ua === null ? `${bot.token} is a robots.txt control token; it never makes requests, so there is no address to verify.` : `${bot.owner} documents no IP list or reverse-DNS check for ${bot.token}, so this address cannot be verified.`, source: bot.docs };
  }
  const steps: { method: VerifyMethod; s: Step }[] = [];
  if (hasList) steps.push({ method: "ip-list", s: await byList(ip, bot, o) });
  if (hasRdns && !steps.some((x) => x.s.verified === true)) steps.push({ method: "reverse-dns", s: await byRdns(ipText, ip, bot, o) });
  const win = steps.find((x) => x.s.verified === true);
  const verified = win ? true : steps.every((x) => x.s.verified === false) ? false : null;
  const detail = (win ? [win] : steps).map((x) => x.s.detail).join(" ");
  return { bot: bot.token, method: (win ?? steps[0]).method, verified, detail, source: hasList ? bot.ipLists!.join(", ") : bot.docs };
}

/**
 * Checks whether an IP address belongs to a crawler, using only methods the operator documents:
 * published IP-range JSON files and forward-confirmed reverse DNS. Never connects to the address.
 * Returns one result for `opts.bot`, or one per catalogue bot that has a method.
 */
export async function verifyBotIp(ip: string, opts: VerifyOptions = {}): Promise<VerifyResult[]> {
  const parsed = parseIp(ip);
  if (!parsed) throw new Error(`Not a valid IPv4 or IPv6 address: ${ip.slice(0, 100)}`);
  const v = parsed.value;
  const text = parsed.family === 4 ? [24n, 16n, 8n, 0n].map((n) => (v >> n) & 255n).join(".") : ip.trim().replace(/^\[|\]$/g, "");
  if (opts.bot !== undefined) {
    const bot = findBot(opts.bot);
    if (!bot) throw new Error(`Unknown bot "${opts.bot.slice(0, 100)}". Known: ${BOTS.map((b) => b.token).join(", ")}.`);
    return [await verifyOne(text, parsed, bot, opts)];
  }
  const out: VerifyResult[] = [];
  for (const b of BOTS) if (b.ipLists?.length || b.rdnsSuffixes?.length) out.push(await verifyOne(text, parsed, b, opts));
  return out;
}
