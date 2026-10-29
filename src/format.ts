import { failingBots, type CheckReport } from "./check.js";

/** Escapes text that comes from the checked URL or the network so it cannot break out of a Markdown table or heading. */
const md = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[\\`*_<>|[\]]/g, "\\$&");

/**
 * GitHub-flavoured Markdown for CI summaries. `failed` is the list of bots that broke the --fail-on policy. A bot that is blocked
 * but not in `failed` (no policy set) is still marked blocked, so the summary never shows a green tick for a closed site.
 */
export function formatMarkdown(r: CheckReport, failed: string[]): string {
  const bad = new Set([...failed, ...failingBots(r, "blocked")]);
  const t = r.robotsTxt;
  let partial = false;
  const rows = r.bots.map((b) => {
    const open = b.robots.access === "partial" && b.robots.pathAllowed !== false;
    partial ||= open;
    const rb = b.robots.access === "unknown" ? "unknown" : b.robots.pathAllowed === false ? "blocked" : open ? "allowed\\*" : "allowed";
    const h = b.http;
    const http = !h ? "-" : !h.fetched ? "error" : `${h.status}${h.looksBlocked ? " (block page)" : ""}`;
    const result = failed.includes(b.bot) ? "❌ fail" : bad.has(b.bot) ? "❌ blocked" : "✅ ok";
    return `| ${md(b.bot)} | ${rb} | ${http} | ${result} |`;
  });
  const robots = `${t.state}${t.status ? ` (HTTP ${t.status})` : t.error ? ` (${md(t.error)})` : ""}`;
  const lines = [
    `## AI crawler access: ${md(r.url)}`,
    "",
    bad.size ? `❌ ${bad.size} of ${r.bots.length} bot(s) blocked or failing: ${[...bad].map(md).join(", ")}` : `✅ No checked bot is blocked (${r.bots.length} bots).`,
    "",
    `robots.txt: ${robots} at ${md(t.url)}`,
    "",
    "| Bot | robots.txt | HTTP | Result |",
    "| --- | --- | --- | --- |",
    ...rows,
  ];
  if (partial) lines.push("", "\\* allowed for this path; robots.txt closes other parts of the site.");
  return lines.join("\n") + "\n";
}
