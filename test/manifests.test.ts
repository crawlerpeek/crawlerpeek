import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { TOOLS } from "../src/mcp.js";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const server = { command: "npx", args: ["-y", "crawlerpeek", "mcp"] };

describe("distribution manifests", () => {
  it("carry the package version", () => {
    expect(json("package.json").version).toBe(VERSION);
    const registry = json("server.json");
    expect(registry.version).toBe(VERSION);
    expect(registry.packages[0].version).toBe(VERSION);
    expect(json(".claude-plugin/plugin.json").version).toBe(VERSION);
    expect(json(".claude-plugin/marketplace.json").plugins[0].version).toBe(VERSION);
    expect(json("mcpb/manifest.json").version).toBe(VERSION);
    expect(read("skills/crawlerpeek/SKILL.md")).toContain(`version: "${VERSION}"`);
  });

  it("start the same MCP server everywhere", () => {
    expect(json(".claude-plugin/plugin.json").mcpServers.crawlerpeek).toEqual(server);
    const manifest = json("mcpb/manifest.json");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/cli.js", "mcp"]);
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });

  it("link the marketplace entry to the plugin", () => {
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins[0].name).toBe(json(".claude-plugin/plugin.json").name);
  });

  it("keep SKILL.md frontmatter to the fields every agent accepts", () => {
    const front = read("skills/crawlerpeek/SKILL.md").split("---")[1];
    const keys = [...front.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["name", "description", "license", "compatibility", "metadata"]);
    expect(front).toMatch(/^name: crawlerpeek$/m);
    expect(front.match(/^description: (.*)$/m)![1].length).toBeLessThanOrEqual(1024);
  });

  it("README install links decode to the server command", () => {
    const readme = read("README.md");
    const cursor = readme.match(/cursor\.com\/install-mcp\?name=crawlerpeek&config=([A-Za-z0-9+/=]+)/)![1];
    expect(JSON.parse(Buffer.from(cursor, "base64").toString())).toEqual(server);
    const vscode = [...readme.matchAll(/insiders\.vscode\.dev\/redirect\/mcp\/install\?name=crawlerpeek&config=([^&)]+)/g)];
    expect(vscode).toHaveLength(2);
    for (const m of vscode) expect(JSON.parse(decodeURIComponent(m[1]))).toEqual(server);
  });
});
