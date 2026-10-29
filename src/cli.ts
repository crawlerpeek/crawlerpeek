import { statSync, readFileSync } from "node:fs";
import { checkAiAccess, failingBots, seeAsBot, type CheckOptions, type CheckReport, type FailOn } from "./check.js";
import { scanSite, type ScanReport } from "./scan.js";
import { lintCounts, lintFails, lintRobotsTxt, lintRobotsUrl, type LintFinding } from "./lint.js";
import { verifyBotIp } from "./verify.js";
import { generateRobotsTxt } from "./robotsgen.js";
import { serveStdio } from "./mcp.js";
import { VERSION } from "./version.js";

const HELP = `crawlerpeek ${VERSION}: can AI crawlers access your site?

Usage
  crawlerpeek check <url> [--bots a,b|all] [--fail-on none|blocked|any-non-200] [--delay ms] [--json] [--no-http] [--allow-private]
  crawlerpeek see <url> --bot <token> [--json] [--allow-private]
  crawlerpeek verify <ip> [--bot GPTBot] [--json]
  crawlerpeek lint <url|file|-> [--fail-on error|warning] [--json] [--allow-private]
  crawlerpeek scan <url> [--limit 25] [--bots a,b|all] [--fail-on none|blocked] [--json] [--allow-private]
  crawlerpeek robots [--disallow /admin/,/tmp/] [--block-bots CCBot] [--sitemap <url>]
  crawlerpeek mcp [--allow-private]          MCP server on stdio (6 read-only tools)

check   robots.txt decision per bot plus the HTTP status when the page is fetched with each bot's user-agent string.
        Exit code 0 = ok, 1 = --fail-on condition met, 2 = usage or request error.
        --fail-on none         never fail on results (default)
        --fail-on blocked      fail when robots.txt closes the path or the page answers with a block/challenge
        --fail-on any-non-200  also fail on any other status or failed request
        --delay <ms>           pause between the per-bot requests (default 300)
        --no-http              robots.txt only, no page requests
see     Fetch one URL with one bot's user agent (status, redirects, type, size, title, block-page heuristic).
        Exit code 0 = fetched (any HTTP status), 2 = usage error or the request failed.
lint    Check a robots.txt (a URL's /robots.txt, a local file, or - for stdin) for mistakes: HTML instead of robots.txt, typos in
        field names, rules before any User-agent, relative paths or sitemaps, misspelled bot tokens, duplicate or empty groups.
        One line per finding: line, severity (error, warning, info), code, message.
        --fail-on warning      exit 1 on any error or warning (default)
        --fail-on error        exit 1 on errors only
        Exit code 0 = nothing at or above the threshold, 1 = findings, 2 = usage error or the robots.txt could not be fetched.
scan    robots.txt decision per bot for the URLs in the site's sitemap (from robots.txt, else /sitemap.xml; a sitemap index is followed
        one level). Reads only robots.txt and the sitemap files, never the pages. Same host only; .gz sitemaps are skipped.
        --limit <n>            URLs to check, 1 to 200 (default 25)
        --fail-on blocked      exit 1 when any checked bot is blocked from any URL (default none)
        Exit code 0 = ok, 1 = --fail-on condition met, 2 = usage or request error, or no URL found in the sitemap.
verify  Does this IP address really belong to a crawler? Uses only what the operator documents: its published IP-range list
        or forward-confirmed reverse DNS. Without --bot, every bot that has such a method is checked. Never connects to the IP.
        Exit code 0 = verified for at least one bot, 1 = not verified or undecidable (list unreachable, no method), 2 = usage error.
Note    The user-agent strings are the bots' own and are sent from this machine, not from the operators' IP ranges.
        A site that verifies bot IPs may answer differently to the real bot. Private/loopback targets are refused unless --allow-private.
`;

type Io = { out: (s: string) => void; err: (s: string) => void; stdin?: () => Promise<string> };
/** Network overrides for tests and embedding; the CLI itself uses the built-in transport. */
type Net = Pick<CheckOptions, "fetch" | "resolve">;
const MAX_INPUT = 5 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += (c as Buffer).length;
    if (n > MAX_INPUT) throw new Error("Input is larger than 5 MB.");
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}
const defaultIo: Io = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") };

/** Each command lists the options it accepts; anything else is an error, so a typo such as --failon cannot silently pass a CI run. */
function parseArgs(argv: string[], valueFlags: string[], boolFlags: string[] = []) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  const unknown = (a: string) => new Error(`Unknown option ${a.split("=")[0]}. Run "crawlerpeek --help" for the options of each command.`);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (valueFlags.includes(k)) {
        const val = v ?? argv[++i];
        if (val === undefined) throw new Error(`--${k} needs a value.`);
        flags[k] = val;
      } else if (boolFlags.includes(k)) {
        if (v !== undefined) throw new Error(`--${k} takes no value.`);
        flags[k] = true;
      } else throw unknown(a);
    } else if (a.length > 1 && a.startsWith("-")) throw unknown(a);
    else pos.push(a);
  }
  return { flags, pos };
}
const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
export function formatTable(r: CheckReport, failed: string[]): string {
  const rows = r.bots.map((b) => {
    const rb = b.robots.access === "unknown" ? "unknown" : b.robots.pathAllowed === false ? "blocked" : b.robots.access === "partial" ? "allowed*" : "allowed";
    const h = b.http;
    const http = !h ? "-" : !h.fetched ? "error" : `${h.status}${h.looksBlocked ? " (block page)" : ""}`;
    return [b.bot, rb, http, failed.includes(b.bot) ? "FAIL" : ""];
  });
  const w = [Math.max(3, ...rows.map((x) => x[0].length)), 8, Math.max(4, ...rows.map((x) => x[2].length))];
  const lines = [`${r.url}`, `robots.txt: ${r.robotsTxt.state}${r.robotsTxt.status ? ` (HTTP ${r.robotsTxt.status})` : r.robotsTxt.error ? ` (${r.robotsTxt.error})` : ""} at ${r.robotsTxt.url}`, ""];
  lines.push(`${pad("Bot", w[0])}  ${pad("robots", w[1])}  ${pad("HTTP", w[2])}`);
  for (const x of rows) lines.push(`${pad(x[0], w[0])}  ${pad(x[1], w[1])}  ${pad(x[2], w[2])}  ${x[3]}`.trimEnd());
  if (rows.some((x) => x[1] === "allowed*")) lines.push("", "* allowed for this path; robots.txt closes other parts of the site.");
  return lines.join("\n");
}

export function formatScan(r: ScanReport): string {
  const w = Math.max(3, ...r.summary.perBot.map((b) => b.bot.length));
  const n = r.summary.urlsChecked;
  const t = r.robotsTxt;
  const lines = [r.site, `robots.txt: ${t.state}${t.status ? ` (HTTP ${t.status})` : t.error ? ` (${t.error})` : ""} at ${t.url}`, `${n} URL(s) checked from ${r.sitemaps.filter((s) => s.urls > 0).length} of ${r.sitemaps.length} sitemap file(s)`];
  for (const s of r.sitemaps) if (s.error) lines.push(`  ${s.url}: ${s.error}`);
  lines.push("", `${pad("Bot", w)}  Blocked`);
  for (const b of r.summary.perBot) lines.push(`${pad(b.bot, w)}  ${b.blocked} of ${n}${b.undecided ? " (undecided: too many rules)" : ""}`);
  for (const b of r.summary.perBot.filter((x) => x.blocked > 0)) {
    const hit = r.urls.filter((u) => u.blockedFor.includes(b.bot));
    lines.push("", `${b.bot}: blocked from`, ...hit.slice(0, 10).map((u) => `  ${u.url}`));
    if (hit.length > 10) lines.push(`  ... and ${hit.length - 10} more`);
  }
  return lines.join("\n");
}

export async function main(argv: string[], io: Io = defaultIo, net: Net = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { io.out(HELP); return cmd ? 0 : 2; }
    if (cmd === "--version" || cmd === "-v" || cmd === "version") { io.out(VERSION); return 0; }
    if (rest.includes("--help") && ["mcp", "robots", "see", "check", "verify", "lint", "scan"].includes(cmd)) { io.out(HELP); return 0; }
    if (cmd === "mcp") {
      const { flags } = parseArgs(rest, [], ["allow-private"]);
      await serveStdio(process.stdin, process.stdout, { allowPrivate: flags["allow-private"] === true });
      return 0;
    }
    if (cmd === "robots") {
      const { flags } = parseArgs(rest, ["disallow", "block-bots", "sitemap"]);
      io.out(generateRobotsTxt({ disallow: list(flags.disallow), blockBots: list(flags["block-bots"]), sitemap: typeof flags.sitemap === "string" ? flags.sitemap : undefined }).trimEnd());
      return 0;
    }
    if (cmd === "see") {
      const { flags, pos } = parseArgs(rest, ["bot"], ["json", "allow-private"]);
      if (!pos[0] || typeof flags.bot !== "string") { io.err("Usage: crawlerpeek see <url> --bot <token>"); return 2; }
      const r = await seeAsBot(pos[0], flags.bot, { allowPrivate: flags["allow-private"] === true, ...net });
      io.out(flags.json ? JSON.stringify(r, null, 2) : Object.entries(r).map(([k, v]) => `${pad(k, 12)} ${v === null || v === "" ? "-" : v}`).join("\n"));
      return r.fetched ? 0 : 2;
    }
    if (cmd === "lint") {
      const { flags, pos } = parseArgs(rest, ["fail-on"], ["json", "allow-private"]);
      if (pos.length !== 1) { io.err("Usage: crawlerpeek lint <url|file|-> [--fail-on error|warning] [--json]"); return 2; }
      const failOn = (flags["fail-on"] ?? "warning") as string;
      if (failOn !== "error" && failOn !== "warning") { io.err(`--fail-on must be error or warning (got "${failOn}").`); return 2; }
      const src = pos[0];
      let findings: LintFinding[];
      let head: Record<string, unknown>;
      let note: string | null = null;
      const isFile = src !== "-" && (() => { try { return statSync(src).isFile(); } catch { return false; } })();
      if (src === "-" || isFile) {
        if (isFile && statSync(src).size > MAX_INPUT) throw new Error("File is larger than 5 MB.");
        findings = lintRobotsTxt(src === "-" ? await (io.stdin ?? readStdin)() : readFileSync(src, "utf8"));
        head = { source: src === "-" ? "stdin" : src };
      } else {
        const r = await lintRobotsUrl(src, { allowPrivate: flags["allow-private"] === true, ...net });
        if (r.state === "unavailable") throw new Error(`Could not fetch ${r.url}${r.error ? ` (${r.error})` : ""}.`);
        findings = r.findings;
        note = r.note;
        head = { source: r.url, status: r.status, state: r.state };
      }
      const counts = lintCounts(findings);
      const failed = lintFails(findings, failOn);
      if (flags.json) io.out(JSON.stringify({ ...head, note, findings, counts, failOn, failed }, null, 2));
      else {
        const lines = findings.map((f) => `${pad(f.line === null ? "-" : `L${f.line}`, 6)} ${pad(f.severity, 8)} ${pad(f.code, 24)} ${f.message}`.trimEnd());
        if (note) lines.push(note);
        lines.push(findings.length ? `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info in ${String(head.source)}` : `No issues found in ${String(head.source)}.`);
        io.out(lines.join("\n"));
      }
      return failed ? 1 : 0;
    }
    if (cmd === "scan") {
      const { flags, pos } = parseArgs(rest, ["limit", "bots", "fail-on"], ["json", "allow-private"]);
      if (pos.length !== 1) { io.err("Usage: crawlerpeek scan <url> [--limit 25] [--bots a,b|all] [--fail-on none|blocked] [--json]"); return 2; }
      const failOn = (flags["fail-on"] ?? "none") as string;
      if (failOn !== "none" && failOn !== "blocked") { io.err(`--fail-on must be none or blocked (got "${failOn}").`); return 2; }
      if (flags.limit !== undefined && !(typeof flags.limit === "string" && /^\d{1,4}$/.test(flags.limit) && Number(flags.limit) >= 1 && Number(flags.limit) <= 200)) { io.err("--limit must be a whole number from 1 to 200."); return 2; }
      const bots = list(flags.bots);
      const report = await scanSite(pos[0], {
        bots: bots?.length === 1 && bots[0].toLowerCase() === "all" ? "all" : bots,
        limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
        allowPrivate: flags["allow-private"] === true,
        ...net,
      });
      const failed = failOn === "blocked" ? report.summary.perBot.filter((b) => b.blocked > 0).map((b) => b.bot) : [];
      io.out(flags.json ? JSON.stringify({ ...report, failOn, failed }, null, 2) : formatScan(report));
      if (report.summary.urlsChecked === 0) { io.err("No URLs found: the sitemap is missing, empty, gzip-compressed or on another host."); return 2; }
      if (failed.length) { io.err(`${failed.length} bot(s) blocked from at least one URL: ${failed.join(", ")}`); return 1; }
      return 0;
    }
    if (cmd === "verify") {
      const { flags, pos } = parseArgs(rest, ["bot"], ["json"]);
      if (pos.length !== 1 || flags.bot === true) { io.err("Usage: crawlerpeek verify <ip> [--bot GPTBot] [--json]"); return 2; }
      const results = await verifyBotIp(pos[0], { bot: typeof flags.bot === "string" ? flags.bot : undefined });
      io.out(flags.json ? JSON.stringify(results, null, 2) : results.map((r) => `${pad(r.bot, 20)} ${pad(r.verified === null ? "unknown" : r.verified ? "verified" : "not verified", 12)} ${pad(r.method, 12)} ${r.detail}`).join("\n"));
      return results.some((r) => r.verified) ? 0 : 1;
    }
    if (cmd === "check") {
      const { flags, pos } = parseArgs(rest, ["bots", "fail-on", "delay"], ["json", "no-http", "allow-private"]);
      if (!pos[0]) { io.err("Usage: crawlerpeek check <url> [--bots a,b] [--fail-on blocked|any-non-200] [--json]"); return 2; }
      const failOn = (flags["fail-on"] ?? "none") as string;
      if (!["none", "blocked", "any-non-200"].includes(failOn)) { io.err(`--fail-on must be none, blocked or any-non-200 (got "${failOn}").`); return 2; }
      if (flags.delay !== undefined && !(typeof flags.delay === "string" && /^\d+$/.test(flags.delay))) { io.err("--delay must be a whole number of milliseconds."); return 2; }
      const bots = list(flags.bots);
      const report = await checkAiAccess(pos[0], {
        bots: bots?.length === 1 && bots[0].toLowerCase() === "all" ? "all" : bots,
        http: flags["no-http"] !== true,
        allowPrivate: flags["allow-private"] === true,
        delayMs: typeof flags.delay === "string" ? Number(flags.delay) : undefined,
        ...net,
      });
      const failed = failingBots(report, failOn as FailOn);
      io.out(flags.json ? JSON.stringify({ ...report, failOn, failed }, null, 2) : formatTable(report, failed));
      if (failed.length) { io.err(`${failed.length} bot(s) failed --fail-on ${failOn}: ${failed.join(", ")}`); return 1; }
      return 0;
    }
    io.err(`Unknown command "${cmd}".\n\n${HELP}`);
    return 2;
  } catch (e) {
    io.err(`crawlerpeek: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
