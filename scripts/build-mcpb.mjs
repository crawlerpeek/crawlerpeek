// Packs dist/crawlerpeek-<version>.mcpb for Claude Desktop from the built package (run `npm run build` first).
// The server has no runtime dependencies, so the bundle holds only the compiled ES modules.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"));
if (manifest.version !== version) throw new Error(`mcpb/manifest.json is ${manifest.version}, package.json is ${version}.`);
statSync("dist/cli.js");

const stage = "dist/mcpb-stage";
const out = `dist/crawlerpeek-${version}.mcpb`;
rmSync(stage, { recursive: true, force: true });
rmSync(out, { force: true });
mkdirSync(`${stage}/server`, { recursive: true });
cpSync("mcpb/manifest.json", `${stage}/manifest.json`);
cpSync("LICENSE", `${stage}/LICENSE`);
cpSync("dist/cli.js", `${stage}/server/cli.js`);
cpSync("dist/esm", `${stage}/server/esm`, { recursive: true, filter: (src) => !src.endsWith(".d.ts") });
writeFileSync(`${stage}/server/package.json`, JSON.stringify({ type: "module" }) + "\n");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["-y", MCPB, "validate", `${stage}/manifest.json`], { stdio: "inherit" });
execFileSync(npx, ["-y", MCPB, "pack", stage, out], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`Built ${out}`);
