import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsPromises } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export const TIMEOUT_MS = 10_000;
export const MAX_BODY = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export class NetError extends Error {
  /** `redirect` is true when a later hop failed, not the URL the caller supplied. */
  constructor(public code: "blocked" | "invalid_url" | "timeout" | "network" | "redirects", message: string, public redirect = false) {
    super(message);
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001::", 32], ["2001:db8::", 32], ["64:ff9b:1::", 48]] as const) blocked.addSubnet(net, bits, "ipv6");

function hextets(addr: string): number[] {
  const [head, tail = ""] = addr.split("::");
  const parse = (s: string) => {
    if (!s) return [];
    const parts = s.split(":");
    const last = parts[parts.length - 1];
    if (last.includes(".")) {
      const [a, b, c, d] = last.split(".").map(Number);
      parts.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return parts.map((p) => parseInt(p, 16));
  };
  const h = parse(head);
  const t = parse(tail);
  return addr.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h;
}
const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses, including IPv6 forms that embed an IPv4 address. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return blocked.check(a, "ipv4");
  if (kind !== 6) return true;
  if (blocked.check(a, "ipv6")) return true;
  const h = hextets(a);
  if ((h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) || (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0))) return blocked.check(v4(h[6], h[7]), "ipv4");
  if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return blocked.check(v4(h[6], h[7]), "ipv4");
  if (h[0] === 0x2002) return blocked.check(v4(h[1], h[2]), "ipv4");
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
export type NetOptions = {
  userAgent: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Allow private, loopback and link-local targets and ports other than 80/443. Default false. */
  allowPrivate?: boolean;
  /** DNS resolver used for the SSRF check (default: system resolver, all addresses). */
  resolve?: Resolver;
  /** Replaces the built-in HTTP transport (tests, custom proxies). Must not follow redirects itself. */
  fetch?: typeof fetch;
};

export type Fetched = {
  status: number;
  finalUrl: string;
  redirects: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
};

const defaultResolve: Resolver = async (host) => (await dnsPromises(host, { all: true })).map((r) => r.address);

/** Throws NetError("blocked") unless every address the host resolves to is public. */
export async function assertPublicTarget(raw: string, o: Pick<NetOptions, "allowPrivate" | "resolve">): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new NetError("invalid_url", `Not a valid URL: ${raw.slice(0, 200)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetError("invalid_url", "Only http and https URLs are supported.");
  if (o.allowPrivate) return url;
  if (url.username || url.password) throw new NetError("blocked", "URLs with credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new NetError("blocked", "Only ports 80 and 443 are allowed (use --allow-private to lift this).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : await (o.resolve ?? defaultResolve)(host); } catch { throw new NetError("network", `Could not resolve ${host}.`); }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new NetError("blocked", `${host} points to a private, loopback or link-local address (use --allow-private to lift this).`);
  return url;
}

type Raw = { status: number; headers: Record<string, string>; read: (max: number) => Promise<{ body: string; bytes: number; truncated: boolean }> };

async function readStream(chunks: AsyncIterable<Uint8Array>, max: number) {
  const parts: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const c of chunks) {
    const buf = Buffer.from(c);
    if (bytes + buf.length > max) { parts.push(buf.subarray(0, max - bytes)); bytes = max; truncated = true; break; }
    parts.push(buf);
    bytes += buf.length;
  }
  return { body: Buffer.concat(parts).toString("utf8"), bytes, truncated };
}

function viaFetch(f: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Raw> {
  return f(url, { redirect: "manual", headers, signal }).then((res) => {
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return {
      status: res.status,
      headers: h,
      read: async (max) => {
        if (!res.body) return { body: "", bytes: 0, truncated: false };
        const r = await readStream(res.body as unknown as AsyncIterable<Uint8Array>, max);
        void res.body.cancel().catch(() => {});
        return r;
      },
    };
  });
}

/** Built-in transport: the DNS answer is validated at connect time, so the checked address is the one that is used (no rebinding gap). */
function viaNode(url: URL, headers: Record<string, string>, signal: AbortSignal, allowPrivate: boolean): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, {
      method: "GET", headers, signal,
      lookup: (host, opts, cb) => {
        const done = cb as (e: Error | null, a?: unknown, f?: number) => void;
        dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
          if (err) return done(err);
          const list = addrs as { address: string; family: number }[];
          if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) return done(new Error("private address"));
          if (opts.all) return done(null, list);
          done(null, list[0].address, list[0].family);
        });
      },
    }, (res) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      resolve({
        status: res.statusCode ?? 0,
        headers: h,
        read: async (max) => { const r = await readStream(res, max); res.destroy(); return r; },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** GET with manual redirects (at most 5, each hop re-checked), one overall deadline, and a body cap. */
export async function guardedGet(rawUrl: string, o: NetOptions): Promise<Fetched> {
  const maxBytes = o.maxBytes ?? MAX_BODY;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_MS);
  const headers: Record<string, string> = { "user-agent": o.userAgent, accept: o.accept ?? "text/html,application/xhtml+xml,*/*;q=0.8", "accept-encoding": "identity" };
  let current = rawUrl;
  try {
    for (let hop = 0; ; hop++) {
      let url: URL;
      try { url = await assertPublicTarget(current, o); } catch (e) {
        if (hop > 0 && e instanceof NetError) throw new NetError(e.code, `Redirect refused: ${e.message}`, true);
        throw e;
      }
      let raw: Raw;
      try {
        raw = o.fetch ? await viaFetch(o.fetch, url.href, headers, ctl.signal) : await viaNode(url, headers, ctl.signal, !!o.allowPrivate);
      } catch (e) {
        if (ctl.signal.aborted) throw new NetError("timeout", "The request timed out.");
        if (e instanceof NetError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new NetError(/private address/.test(msg) ? "blocked" : "network", /private address/.test(msg) ? "The host resolved to a private address." : `Connection failed (${msg.slice(0, 120)}).`);
      }
      const loc = raw.headers["location"];
      if (raw.status >= 300 && raw.status < 400 && loc) {
        await raw.read(0).catch(() => {});
        if (hop >= maxRedirects) throw new NetError("redirects", `More than ${maxRedirects} redirects.`);
        try { current = new URL(loc, url).href; } catch { throw new NetError("invalid_url", "Redirect refused: invalid Location header.", true); }
        continue;
      }
      let body;
      try { body = await raw.read(maxBytes); } catch { throw new NetError(ctl.signal.aborted ? "timeout" : "network", ctl.signal.aborted ? "The request timed out." : "The connection dropped while reading."); }
      return { status: raw.status, finalUrl: url.href, redirects: hop, headers: raw.headers, contentType: raw.headers["content-type"] ?? "", ...body };
    }
  } finally {
    clearTimeout(timer);
  }
}
