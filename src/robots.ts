/**
 * robots.txt parsing and evaluation (RFC 9309): groups by user-agent token, wildcard and `$` patterns, longest matching rule wins,
 * Allow wins a tie, no match means allowed. Mirrors the evaluation used by the crawlerpeek.com checker.
 * robots.txt is untrusted input: no regular expressions (no backtracking), capped sizes and a step budget.
 */
export type Rule = { allow: boolean; path: string };
export type Budget = { steps: number; exceeded: boolean };
export type Parsed = { groups: { agents: string[]; rules: Rule[] }[]; sitemaps: string[]; budget: Budget };
export type Access = "allowed" | "partial" | "blocked";

export const LIMITS = { path: 256, pattern: 200, rulesPerGroup: 1000, steps: 2_000_000 } as const;
const newBudget = (): Budget => ({ steps: LIMITS.steps, exceeded: false });

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * RFC 9309 section 2.2.2: octets outside US-ASCII are percent-encoded as UTF-8, percent-encoded octets get upper-case hex, and
 * unreserved characters are decoded, so `/ü`, `/%C3%BC` and `/%c3%bc` compare equal, as do `/~a` and `/%7Ea`. Applied to rules and request paths.
 */
export function normalizePath(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "%" && HEX.test(p.slice(i + 1, i + 3))) {
      const ch = String.fromCharCode(parseInt(p.slice(i + 1, i + 3), 16));
      out += UNRESERVED.test(ch) ? ch : "%" + p.slice(i + 1, i + 3).toUpperCase();
      i += 2;
    } else if (c.charCodeAt(0) < 0x80) out += c;
    else {
      const cp = p.codePointAt(i) as number;
      if (cp > 0xffff) i++;
      out += cp >= 0xd800 && cp <= 0xdfff ? "%EF%BF%BD" : encodeURIComponent(String.fromCodePoint(cp));
    }
  }
  return out;
}

export function parseRobots(text: string): Parsed {
  const groups: Parsed["groups"] = [];
  const sitemaps: string[] = [];
  let cur: Parsed["groups"][number] | null = null;
  let lastWasAgent = false;
  let ruleCount = 0;
  for (const raw of text.replace(/^﻿/, "").slice(0, 512_000).split(/\r?\n/).slice(0, 20_000)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 1) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    // Only rule lines end a run of User-agent lines (Google/RFC 9309 behaviour): Sitemap, Crawl-delay or unknown fields between two
    // User-agent lines must not split them into separate groups.
    if (field === "allow" || field === "disallow") lastWasAgent = false;
    if (field === "sitemap") sitemaps.push(value);
    else if ((field === "allow" || field === "disallow") && cur && ++ruleCount <= 5000 && cur.rules.length < LIMITS.rulesPerGroup) {
      cur.rules.push({ allow: field === "allow", path: normalizePath(value) });
    }
  }
  return { groups, sitemaps, budget: newBudget() };
}

/** Length with every percent-encoded octet (`%XX`) counted as one unit, so limits apply to what was written and a long non-ASCII rule is not ignored after normalization. */
const units = (s: string) => s.length - 2 * (s.match(/%[0-9A-F]{2}/g)?.length ?? 0);
/** Index at which `s` exceeds `max` units (s.length when it does not). */
function cutIndex(s: string, max: number): number {
  let u = 0;
  for (let i = 0; i < s.length; i++) {
    if (++u > max) return i;
    if (s[i] === "%" && HEX.test(s.slice(i + 1, i + 3))) i += 2;
  }
  return s.length;
}

/** Pattern length when the rule matches the path (counting `*` and `$`), else -1. Linear wildcard matcher. */
export function matchLen(pattern: string, path: string, budget?: Budget): number {
  if (!pattern || units(pattern) > LIMITS.pattern) return -1;
  if (budget?.exceeded) return -1;
  const anchored = pattern.endsWith("$");
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  const cutAt = cutIndex(path, LIMITS.path);
  const cut = cutAt < path.length;
  if (cut && anchored) return -1;
  const s = cut ? path.slice(0, cutAt) : path;
  let pi = 0, si = 0, star = -1, mark = 0;
  while (si < s.length) {
    if (budget && --budget.steps < 0) { budget.exceeded = true; return -1; }
    if (!anchored && pi === pat.length) return pattern.length;
    if (pi < pat.length && pat[pi] === "*") { star = pi++; mark = si; }
    else if (pi < pat.length && pat[pi] === s[si]) { pi++; si++; }
    else if (star >= 0) { pi = star + 1; si = ++mark; }
    else return -1;
  }
  while (pi < pat.length && pat[pi] === "*") pi++;
  return pi === pat.length ? pattern.length : -1;
}

/** The longest matching rule wins; Allow wins a tie; no match means allowed. */
export function isAllowed(rules: Rule[], path: string, budget?: Budget): boolean {
  let best = { len: -1, allow: true };
  for (const r of rules) {
    if (budget?.exceeded) return true;
    const len = matchLen(r.path, path, budget);
    if (len < 0) continue;
    if (len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best.allow;
}

/** Rules for one user-agent token: all groups naming it (case-insensitive), else the `*` groups. */
export function rulesFor(parsed: Parsed, token: string): { rules: Rule[]; matchedGroup: string } {
  const t = token.toLowerCase();
  let matched = parsed.groups.filter((g) => g.agents.includes(t));
  let name = token;
  if (matched.length === 0) {
    matched = parsed.groups.filter((g) => g.agents.includes("*"));
    name = "*";
  }
  return { rules: matched.flatMap((g) => g.rules).slice(0, LIMITS.rulesPerGroup), matchedGroup: matched.length ? name : "" };
}

const PROBE_PATH = "/crawlerpeek-probe/page";

/** Whole site open, only partly open, or closed, independent of the requested path. */
export function evaluateToken(parsed: Parsed, token: string): { status: Access; matchedGroup: string; disallowed: string[]; allowedPaths: string[] } {
  const { rules, matchedGroup } = rulesFor(parsed, token);
  const b = parsed.budget;
  const rootOpen = isAllowed(rules, "/", b);
  const siteOpen = isAllowed(rules, PROBE_PATH, b);
  const wide = rootOpen && siteOpen;
  const disallowed = rules.filter((r) => !r.allow && r.path && (!wide || r.path !== "/")).map((r) => r.path);
  const allowedPaths = wide ? [] : rules.filter((r) => r.allow && r.path && r.path !== "/").map((r) => r.path);
  let status: Access;
  if (wide) status = disallowed.length ? "partial" : "allowed";
  else if (rootOpen || siteOpen || allowedPaths.length) status = "partial";
  else status = "blocked";
  return { status, matchedGroup, disallowed, allowedPaths };
}

export type RobotsState = "ok" | "missing" | "unavailable";
export type BotRobots = { access: Access | "unknown"; pathAllowed: boolean | null; matchedGroup: string; disallowed: string[] };

/**
 * Decision for one token on one path. `pathAllowed` answers "may it fetch this exact path"; `access` is the site-wide picture:
 * blocked when the path is closed, partial when the path is open but other parts are not (a few Disallow lines like /admin are normal
 * and still count as allowed when "/" and a generic page are open). A missing robots.txt allows everything; an unfetchable or
 * budget-exhausting one gives "unknown", never "blocked".
 */
export function botRobots(state: RobotsState, parsed: Parsed | null, token: string, path: string): BotRobots {
  if (state === "missing") return { access: "allowed", pathAllowed: true, matchedGroup: "", disallowed: [] };
  if (state === "unavailable" || !parsed) return { access: "unknown", pathAllowed: null, matchedGroup: "", disallowed: [] };
  const b = parsed.budget;
  path = normalizePath(path);
  const ev = evaluateToken(parsed, token);
  const { rules } = rulesFor(parsed, token);
  const open = isAllowed(rules, path, b);
  const generic = isAllowed(rules, "/some/page", b);
  if (b.exceeded) return { access: "unknown", pathAllowed: null, matchedGroup: ev.matchedGroup, disallowed: [] };
  const base = { matchedGroup: ev.matchedGroup, disallowed: ev.disallowed };
  if (!open) return { ...base, access: "blocked", pathAllowed: false };
  if (ev.status === "partial" && isAllowed(rules, "/", b) && generic) return { ...base, access: "allowed", pathAllowed: true };
  return { ...base, access: ev.status === "blocked" ? "partial" : ev.status, pathAllowed: true };
}
