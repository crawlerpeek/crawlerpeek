// Builds dist/esm (ES modules), dist/cjs (CommonJS), dist/types and the dist/cli.js launcher with the TypeScript compiler; no other build tool needed.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const tsc = (project) => execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "tsc", "-p", project], { stdio: "inherit" });
tsc("tsconfig.json");
tsc("tsconfig.cjs.json");
for (const [dir, type] of [["dist/esm", "module"], ["dist/cjs", "commonjs"]]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type }) + "\n");
}
writeFileSync("dist/package.json", JSON.stringify({ type: "module" }) + "\n");
writeFileSync("dist/cli.js", `#!/usr/bin/env node\nimport { main } from "./esm/cli.js";\nprocess.exitCode = await main(process.argv.slice(2));\n`);
chmodSync("dist/cli.js", 0o755);
