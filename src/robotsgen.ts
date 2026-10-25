import { BOTS, type BotKind } from "./bots.js";
import { findBot } from "./check.js";

export type RobotsGenOptions = {
  /** Paths no bot should fetch (for example "/admin/", "/*?session="). Repeated into the AI group so they apply to it. */
  disallow?: string[];
  /** Tokens or slugs to close completely, for example ["CCBot"]. Default: none; the stance is that AI crawlers are welcome. */
  blockBots?: string[];
  /** Bot kinds that get an explicit Allow group. Default: training, search, user, control (the AI bots). */
  kinds?: BotKind[];
  sitemap?: string;
};

const PATH_RE = /^[\x21-\x7e]+$/;

/** robots.txt that names every AI bot explicitly and welcomes it, with optional disallowed paths. */
export function generateRobotsTxt(opts: RobotsGenOptions = {}): string {
  const disallow = [...new Set((opts.disallow ?? []).map((p) => p.trim()).filter(Boolean))];
  for (const p of disallow) {
    if (!PATH_RE.test(p) || !(p.startsWith("/") || p.startsWith("*"))) throw new Error(`Invalid path "${p.slice(0, 80)}": use printable characters and start with "/" or "*".`);
  }
  const closed = new Set<string>();
  for (const n of opts.blockBots ?? []) {
    const b = findBot(n);
    if (!b) throw new Error(`Unknown bot "${n}". Known: ${BOTS.map((x) => x.token).join(", ")}.`);
    closed.add(b.token);
  }
  const kinds = new Set<BotKind>(opts.kinds ?? ["training", "search", "user", "control"]);
  const open = BOTS.filter((b) => kinds.has(b.kind) && !closed.has(b.token));
  const rules = ["Allow: /", ...disallow.map((p) => `Disallow: ${p}`)];
  const blocks: string[] = [];
  if (open.length) blocks.push([...open.map((b) => `User-agent: ${b.token}`), ...rules].join("\n"));
  if (closed.size) blocks.push([...[...closed].map((t) => `User-agent: ${t}`), "Disallow: /"].join("\n"));
  blocks.push(["User-agent: *", ...rules].join("\n"));
  if (opts.sitemap) {
    if (!/^https?:\/\/[\x21-\x7e]+$/.test(opts.sitemap)) throw new Error("sitemap must be an absolute http(s) URL.");
    blocks.push(`Sitemap: ${opts.sitemap}`);
  }
  return blocks.join("\n\n") + "\n";
}
