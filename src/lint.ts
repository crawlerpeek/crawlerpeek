import { BOTS, DEFAULT_BOT_TOKENS } from "./bots.js";
import { fetchRobots, type CheckOptions } from "./check.js";
import { botRobots, parseRobots, type RobotsState } from "./robots.js";

/**
 * robots.txt linter. Every finding is backed by RFC 9309 or Google's robots.txt documentation
 * (https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt). The text is untrusted: no regular expressions over
 * the whole input, the same size and line caps as the parser, bounded edit distance.
 */
export type LintFinding = { line: number | null; severity: "error" | "warning" | "info"; code: string; message: string };

const MAX_BYTES = 512_000; // Google reads only the first 500 KiB
const MAX_LINES = 20_000;
const MAX_FINDINGS = 200;
const FIELDS = ["user-agent", "allow", "disallow", "sitemap", "crawl-delay", "host", "noindex", "clean-param", "request-rate", "visit-time"];
const NOT_RFC = new Set(["noindex", "host", "clean-param"]);
const LEGACY = new Set(["anthropic-ai", "claude-web"]);
const CATALOGUE = BOTS.map((b) => b.token);
const CLAUDE_DOCS = BOTS.find((b) => b.token === "ClaudeBot")?.docs ?? "";
const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

/** Levenshtein distance, or max + 1 when it exceeds `max` (also for long strings). */
function distance(a: string, b: string, max: number): number {
  if (a.length > 64 || b.length > 64 || Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(prev[b.length], max + 1);
}
const closest = (word: string, list: string[], max: number, minLen = 1): string | null => {
  if (word.length < minLen) return null;
  let best: string | null = null;
  let bestD = max + 1;
  for (const c of list) { const d = distance(word, c.toLowerCase(), max); if (d < bestD) { best = c; bestD = d; } }
  return best;
};
const show = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 60) + "..." : s);
const canonical = (f: string) => (f === "user-agent" ? "User-agent" : f.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase()));

export function lintRobotsTxt(text: string): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (line: number | null, severity: LintFinding["severity"], code: string, message: string) => { out.push({ line, severity, code, message }); };
  const body = text.replace(/^\uFEFF/, "");
  const head = body.slice(0, 4096).toLowerCase();
  if (body.trimStart().startsWith("<") || head.includes("<html")) {
    add(1, "error", "html-instead-of-robots", "The file looks like an HTML page, not a robots.txt. Servers often answer /robots.txt with a page; crawlers ignore the content.");
    return out;
  }
  if (Buffer.byteLength(body) > MAX_BYTES) add(null, "warning", "too-large", "The file is larger than 500 KiB. Google reads only the first 500 KiB; rules after that are ignored.");
  const rawLines = body.slice(0, MAX_BYTES).split(/\r?\n/);
  if (rawLines.length > MAX_LINES) add(MAX_LINES + 1, "info", "too-many-lines", `The file has more than ${MAX_LINES} lines. crawlerpeek evaluates only the first ${MAX_LINES}.`);

  type Group = { agents: { token: string; line: number }[]; rules: number };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  rawLines.slice(0, MAX_LINES).forEach((raw, idx) => {
    const n = idx + 1;
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (!line) return;
    const i = line.indexOf(":");
    if (i < 0) {
      const first = line.split(/\s/, 1)[0].toLowerCase();
      const near = FIELDS.includes(first) ? first : closest(first, FIELDS, 2, 3);
      add(n, "warning", "missing-colon", `Line has no ":" separator and is ignored.${near ? ` Did you mean "${canonical(near)}: ..."?` : ""}`);
      return;
    }
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (!field) { add(n, "warning", "unknown-field", "Line has no field name before the colon and is ignored."); return; }
    if (!FIELDS.includes(field)) {
      const near = closest(field, FIELDS, 2, 4);
      add(n, "warning", "unknown-field", `Unknown field ${show(line.slice(0, i).trim())}; crawlers ignore it.${near ? ` Did you mean ${canonical(near)}?` : ""}`);
      return;
    }
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: 0 }; groups.push(cur); }
      cur.agents.push({ token: value.toLowerCase(), line: n });
      lastWasAgent = true;
      lintAgent(value, n, add);
      return;
    }
    if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!cur) add(n, "warning", "rule-before-user-agent", `${canonical(field)} comes before any User-agent line and is ignored.`);
      else cur.rules++;
      if (value && value[0] !== "/" && value[0] !== "*") add(n, "warning", "path-not-absolute", `Path ${show(value)} should start with "/" or "*"; as written it does not match URL paths.`);
    } else if (field === "sitemap") {
      let ok = false;
      try { const u = new URL(value); ok = (u.protocol === "http:" || u.protocol === "https:") && !!u.host; } catch { /* not a URL */ }
      if (!ok) add(n, "warning", "sitemap-not-absolute", `Sitemap value ${show(value)} is not an absolute http(s) URL.`);
    } else if (field === "crawl-delay") {
      add(n, "info", "unsupported-directive", "Crawl-delay is not part of RFC 9309. Google ignores it; some other crawlers honour it.");
    } else if (NOT_RFC.has(field)) {
      add(n, "info", "unsupported-directive", `${canonical(field)} is not part of RFC 9309 and Google does not support it.`);
    }
  });

  const seen = new Map<string, number>();
  const reported = new Set<string>();
  groups.forEach((g, gi) => {
    if (g.rules === 0) {
      const names = g.agents.map((a) => a.token).join(", ");
      add(g.agents[0].line, "info", "empty-group", `User-agent group for ${show(names)} has no Allow or Disallow rules, so it allows everything; a bot with its own group does not use the "*" group (RFC 9309 2.2.1).`);
    }
    for (const a of g.agents) {
      const first = seen.get(a.token);
      if (first === undefined) seen.set(a.token, gi);
      else if (first !== gi && !reported.has(a.token)) {
        reported.add(a.token);
        add(a.line, "info", "duplicate-agent", `User-agent ${show(a.token)} appears in more than one group; crawlers merge them (RFC 9309 2.2.1).`);
      }
    }
  });

  if (groups.length) {
    const parsed = parseRobots(body);
    const ai = BOTS.filter((b) => DEFAULT_BOT_TOKENS.includes(b.token) && (b.kind === "training" || b.kind === "search" || b.kind === "user"));
    const closed = ai.filter((b) => botRobots("ok", parsed, b.token, "/").pathAllowed === false).length;
    if (closed === ai.length && ai.length) add(null, "warning", "all-ai-blocked", `All ${closed} AI training, search and user crawlers in the default list are blocked from "/".`);
  }

  out.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  if (out.length > MAX_FINDINGS) {
    const cut = out.length - MAX_FINDINGS;
    out.length = MAX_FINDINGS;
    add(null, "info", "findings-truncated", `${cut} more findings not shown.`);
  }
  return out;
}

function lintAgent(value: string, n: number, add: (l: number, s: LintFinding["severity"], c: string, m: string) => void) {
  const t = value.toLowerCase();
  if (!t || t === "*" || CATALOGUE.some((c) => c.toLowerCase() === t)) return;
  if (LEGACY.has(t)) { add(n, "info", "unknown-agent", `${show(value)} is not one of Anthropic's currently documented tokens: ClaudeBot, Claude-User and Claude-SearchBot (${CLAUDE_DOCS}).`); return; }
  const near = closest(t, CATALOGUE.filter((c) => c[0].toLowerCase() === t[0]), 2, 5); // same first letter: real bots such as DotBot or xAI-SearchBot differ from a catalogue token in one or two letters but are not typos
  if (near) add(n, "info", "unknown-agent", `Unknown user-agent ${show(value)}. Did you mean ${near}?`);
}

export type LintUrlResult = { url: string; status: number | null; state: RobotsState; error: string | null; note: string | null; findings: LintFinding[] };
export type LintUrlOptions = Pick<CheckOptions, "allowPrivate" | "resolve" | "fetch" | "timeoutMs">;

/** Fetches `<origin>/robots.txt` (same client and limits as checkAiAccess) and lints it. A missing file has no findings. */
export async function lintRobotsUrl(url: string, opts: LintUrlOptions = {}): Promise<LintUrlResult> {
  const r = await fetchRobots(url, { ...opts, maxBytes: MAX_BYTES + 1024 });
  const base = { url: r.robotsUrl, status: r.status, state: r.state, error: r.error };
  if (r.state === "unavailable") return { ...base, note: "robots.txt could not be fetched, so there is nothing to lint.", findings: [] };
  // A 2xx web page at /robots.txt is the mistake worth reporting; an HTML error page with a 4xx status is just a missing file.
  if (r.html && r.status !== null && r.status < 300) return { ...base, note: null, findings: lintRobotsTxt(r.body) };
  if (r.state === "missing") return { ...base, note: `No robots.txt (HTTP ${r.status}). Crawlers treat a missing file as allow-all.`, findings: [] };
  return { ...base, note: null, findings: lintRobotsTxt(r.body) };
}

export const lintCounts = (f: LintFinding[]) => ({ error: f.filter((x) => x.severity === "error").length, warning: f.filter((x) => x.severity === "warning").length, info: f.filter((x) => x.severity === "info").length });
/** Findings at or above the given severity make `lint` fail. */
export const lintFails = (f: LintFinding[], failOn: "error" | "warning") => f.some((x) => SEVERITY[x.severity] <= SEVERITY[failOn]);
