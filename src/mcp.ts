import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { checkAiAccess, seeAsBot, type CheckOptions } from "./check.js";
import { generateRobotsTxt } from "./robotsgen.js";
import { BOTS } from "./bots.js";
import { VERSION } from "./version.js";

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), exactly three read-only tools. No dependencies.
 * Safety: SSRF guard on every request (unless allowPrivate), 10 s timeout, 2 MB body cap, sequential requests, 10 minute cache per call.
 */
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const CACHE_TTL_MS = 10 * 60 * 1000;

type Json = Record<string, unknown>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };

const botTokens = BOTS.map((b) => b.token);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: "check_ai_access",
    description: "Check whether AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended and others) may access a URL: robots.txt decision per bot plus the live HTTP status when the page is fetched with each bot's user-agent string. Read-only; one request per bot.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: {
        url: { type: "string", description: "Public http(s) URL of the page to check." },
        bots: { type: "array", items: { type: "string" }, description: `Bot tokens to check, or omit for the default 15. Known: ${botTokens.join(", ")}.` },
        http: { type: "boolean", description: "Also fetch the page with each bot's user agent (default true). false checks robots.txt only." },
      },
    },
    annotations: { title: "Check AI crawler access", ...readOnly },
  },
  {
    name: "see_as_bot",
    description: "Fetch one URL with a single bot's user-agent string from this machine and report status, final URL after redirects (max 5), content type, size, page title and whether the response looks like a block or challenge page. Does not prove what the real bot gets (operators verify IP ranges).",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url", "bot"],
      properties: {
        url: { type: "string", description: "Public http(s) URL." },
        bot: { type: "string", description: `Bot token, for example GPTBot. Known: ${botTokens.join(", ")}.` },
      },
    },
    annotations: { title: "See a page as a bot", ...readOnly },
  },
  {
    name: "generate_robots_txt",
    description: "Generate a robots.txt that welcomes AI crawlers, with optional disallowed paths and bots to close. Pure text generation; makes no network requests.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        disallow: { type: "array", items: { type: "string" }, description: 'Paths no bot should fetch, e.g. ["/admin/"].' },
        block_bots: { type: "array", items: { type: "string" }, description: 'Bot tokens to close completely, e.g. ["CCBot"].' },
        sitemap: { type: "string", description: "Absolute sitemap URL." },
      },
    },
    annotations: { title: "Generate robots.txt", ...readOnly, openWorldHint: false },
  },
];

const text = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], ...(typeof obj === "object" && obj !== null ? { structuredContent: obj as Json } : {}) });
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });
const strArr = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${name} must be an array of strings.`);
  return v as string[];
};

export type McpOptions = { allowPrivate?: boolean; now?: () => number; net?: Pick<CheckOptions, "fetch" | "resolve" | "delayMs"> };

export function createMcpServer(o: McpOptions = {}) {
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; value: ToolResult }>();
  const net: CheckOptions = { allowPrivate: o.allowPrivate, ...o.net };

  async function callTool(name: string, args: Json): Promise<ToolResult> {
    try {
      const cached = name !== "generate_robots_txt";
      const key = cached ? `${name}:${JSON.stringify(args)}` : "";
      const hit = cached ? cache.get(key) : undefined;
      if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
      let result: ToolResult;
      if (name === "check_ai_access") {
        if (typeof args.url !== "string") throw new Error("url is required.");
        result = text(await checkAiAccess(args.url, { ...net, bots: strArr(args.bots, "bots"), http: typeof args.http === "boolean" ? args.http : true }));
      } else if (name === "see_as_bot") {
        if (typeof args.url !== "string" || typeof args.bot !== "string") throw new Error("url and bot are required.");
        result = text(await seeAsBot(args.url, args.bot, net));
      } else if (name === "generate_robots_txt") {
        result = text(generateRobotsTxt({ disallow: strArr(args.disallow, "disallow"), blockBots: strArr(args.block_bots, "block_bots"), sitemap: typeof args.sitemap === "string" ? args.sitemap : undefined }));
      } else {
        return fail(`Unknown tool: ${name}`);
      }
      if (cached) {
        cache.set(key, { at: now(), value: result });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      }
      return result;
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Tool failed.");
    }
  }

  /** Handles one JSON-RPC message; returns the response, or null for notifications. */
  async function handle(msg: Rpc): Promise<Json | null> {
    const id = msg.id ?? null;
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!msg || typeof msg.method !== "string") return err(-32600, "Invalid request");
    if (msg.id === undefined) return null; // notification (initialized, cancelled, ...)
    switch (msg.method) {
      case "initialize": {
        const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
        return { jsonrpc: "2.0", id, result: { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "crawlerpeek", version: VERSION } } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool: ${String(name)}`);
        const args = msg.params?.arguments;
        return { jsonrpc: "2.0", id, result: await callTool(name, args && typeof args === "object" ? (args as Json) : {}) };
      }
      default: return err(-32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle, callTool };
}

/** Reads one JSON-RPC message per line from `input`, writes responses to `output` (stdout only carries protocol messages). */
export function serveStdio(input: Readable, output: Writable, o: McpOptions = {}): Promise<void> {
  const server = createMcpServer(o);
  const rl = createInterface({ input });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let res: Json | null;
      try {
        res = await server.handle(JSON.parse(line) as Rpc);
      } catch (e) {
        res = e instanceof SyntaxError ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } : { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } };
      }
      if (res) output.write(JSON.stringify(res) + "\n");
    });
  });
  return new Promise((resolve) => rl.on("close", () => void chain.then(() => resolve())));
}
