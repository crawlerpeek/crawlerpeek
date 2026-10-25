# crawlerpeek

[![npm](https://img.shields.io/npm/v/crawlerpeek)](https://www.npmjs.com/package/crawlerpeek) [![CI](https://github.com/crawlerpeek/crawlerpeek/actions/workflows/ci.yml/badge.svg)](https://github.com/crawlerpeek/crawlerpeek/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Check whether AI crawlers can access your site. For each bot (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Googlebot, Bingbot, CCBot and more) it tells you:

- whether `robots.txt` allows the URL's path for that bot (RFC 9309: user-agent groups, wildcards, `$`, longest match wins), and
- what the page actually returns when fetched with that bot's user-agent string: status, final URL after redirects, content type, size, title, and whether the response looks like a block or challenge page.

It also generates a `robots.txt` that welcomes AI crawlers. A library, a CLI for CI, and an MCP server. Node 20 or newer, no runtime dependencies, ESM and CommonJS, TypeScript types included.

The same checks as a web tool: [crawlerpeek.com](https://crawlerpeek.com). Documentation with examples for CI and MCP clients: [crawlerpeek.com/cli](https://crawlerpeek.com/cli).

## Install

```sh
npm install crawlerpeek       # library
npx crawlerpeek --help        # CLI, no install needed
```

## CLI

```sh
npx crawlerpeek check https://example.com
```

```
https://example.com
robots.txt: ok (HTTP 200) at https://example.com/robots.txt

Bot                 robots    HTTP
GPTBot              blocked   200  FAIL
ClaudeBot           allowed   403 (block page)  FAIL
Google-Extended     allowed   -
```

```sh
npx crawlerpeek check https://example.com/pricing --bots GPTBot,ClaudeBot --fail-on blocked
npx crawlerpeek check https://example.com --bots all --json
npx crawlerpeek check https://example.com --no-http          # robots.txt only
npx crawlerpeek see https://example.com --bot ClaudeBot      # one bot, full detail
npx crawlerpeek verify 66.249.66.1 --bot Googlebot          # is this IP really Googlebot?
npx crawlerpeek robots --disallow /admin/,/cart/ --sitemap https://example.com/sitemap.xml
```

Exit codes: `0` ok, `1` the `--fail-on` condition was met, `2` usage error (including an unknown option) or request error. `see` exits `0` when the page was fetched, whatever its HTTP status, and `2` when the request failed or was refused.

`verify <ip> [--bot GPTBot] [--json]` checks whether an address from your server logs really belongs to a crawler. It uses only what the operator documents: the published IP-range JSON (Google, OpenAI, Anthropic, Perplexity, Bing, Apple, Common Crawl, DuckDuckGo, Ahrefs) or reverse DNS with forward confirmation (Google, Bing, Apple, Common Crawl, Ahrefs). Without `--bot` every bot with such a method is checked. Each result has `method` (`ip-list`, `reverse-dns` or `none`), `verified` (`true`, `false`, or `null` when it cannot be decided, for example the list is unreachable or the operator documents no method) and a `detail`. Lists are cached for one hour, and nothing is ever sent to the IP. Exit codes: `0` verified for at least one bot, `1` not verified or undecidable, `2` usage error.

| `--fail-on` | Fails when |
| --- | --- |
| `blocked` | robots.txt closes the path for a bot, or the page answers that bot with 401/403/406/451 or a challenge page |
| `any-non-200` | as above, or any other status (404, 5xx, redirects that end elsewhere) or a failed request |

Without `--fail-on` the exit code is `0` whatever the result. `--bots` takes tokens or `all`; the default is 15 bots: the main AI crawlers plus Googlebot and Bingbot. A robots.txt that cannot be fetched (timeout, 5xx, a redirect that is refused or has no target) is reported as `unknown`, with the reason in `robotsTxt.error`, and never counts as blocked. Note: this deliberately differs from RFC 9309 §2.3.1.4, where crawlers treat an unreachable robots.txt (5xx) as "disallow everything" (Google does too), so a site whose robots.txt returns 5xx is effectively closed to many bots even though `--fail-on blocked` passes. Treat `unknown` as a problem to fix.

## Library

```ts
import { checkAiAccess, seeAsBot, verifyBotIp, generateRobotsTxt, failingBots } from "crawlerpeek";

const report = await checkAiAccess("https://example.com/pricing", { bots: ["GPTBot", "ClaudeBot"] });
report.bots[0].robots; // { access: "allowed", pathAllowed: true, matchedGroup: "*" }
report.bots[0].http;   // { status: 200, finalUrl, redirects, contentType, bytes, title, looksBlocked, outcome: "ok", ... }
failingBots(report, "blocked"); // ["ClaudeBot"] when it is closed or challenged

await seeAsBot("https://example.com", "PerplexityBot");

await verifyBotIp("66.249.66.1", { bot: "Googlebot" }); // [{ bot: "Googlebot", method: "ip-list", verified: true, detail, source }]

generateRobotsTxt({ disallow: ["/admin/"], blockBots: ["CCBot"], sitemap: "https://example.com/sitemap.xml" });
```

`generateRobotsTxt` names each AI bot explicitly with `Allow: /`. Disallowed paths are repeated in that group on purpose: a bot with its own group ignores the `*` group.

## MCP server

`crawlerpeek mcp` speaks the Model Context Protocol over stdio and exposes four read-only tools: `check_ai_access`, `see_as_bot`, `verify_bot_ip`, `generate_robots_txt`. Results are cached for 10 minutes per call. No LLM is called; the tools only fetch the URL you give them.

<a href="https://cursor.com/install-mcp?name=crawlerpeek&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNyYXdsZXJwZWVrIiwibWNwIl19"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/deeplink/mcp-install-dark.svg"><img src="https://cursor.com/deeplink/mcp-install-light.svg" alt="Add crawlerpeek to Cursor" height="32"></picture></a>
&nbsp;
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=crawlerpeek&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22crawlerpeek%22%2C%22mcp%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=crawlerpeek&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22crawlerpeek%22%2C%22mcp%22%5D%7D&quality=insiders)

| Client | Install |
| --- | --- |
| Claude Code | `claude mcp add --transport stdio crawlerpeek -- npx -y crawlerpeek mcp` |
| Claude Code (plugin: MCP server and skill) | `/plugin marketplace add crawlerpeek/crawlerpeek`, then `/plugin install crawlerpeek@crawlerpeek` |
| Claude Desktop | Download `crawlerpeek-<version>.mcpb` from [Releases](https://github.com/crawlerpeek/crawlerpeek/releases) and open it, or add the JSON below |
| Codex | `codex mcp add crawlerpeek -- npx -y crawlerpeek mcp` |
| VS Code | `code --add-mcp '{"name":"crawlerpeek","type":"stdio","command":"npx","args":["-y","crawlerpeek","mcp"]}'` |
| Any other client | the JSON below |

Generic configuration (Claude Desktop, Cursor, Windsurf, Cline and others use this `mcpServers` shape):

```json
{ "mcpServers": { "crawlerpeek": { "command": "npx", "args": ["-y", "crawlerpeek", "mcp"] } } }
```

VS Code reads `.vscode/mcp.json` with `servers` as the root key and `"type": "stdio"` on the entry. Codex reads `~/.codex/config.toml`; raise the startup timeout so the first `npx` download does not run into the default 10 seconds:

```toml
[mcp_servers.crawlerpeek]
command = "npx"
args = ["-y", "crawlerpeek", "mcp"]
startup_timeout_sec = 30
```

## Agent skill

`skills/crawlerpeek/` is an [Agent Skill](https://agentskills.io/specification): a `SKILL.md` that tells an AI agent when to check AI crawler access, which commands to run, and how to read the result. It uses only the common frontmatter fields, so the same folder works in several agents.

| Agent | Install |
| --- | --- |
| Claude Code | installed with the plugin above, or copy the folder to `~/.claude/skills/crawlerpeek` |
| claude.ai | zip the `crawlerpeek` folder and upload it under Customize > Skills (needs code execution and network access, see the skill's notes) |
| Codex | copy the folder to `~/.agents/skills/` (all projects) or `.agents/skills/` in a repository |
| OpenClaw | copy the folder to `~/.agents/skills/` or to `skills/` in your workspace |
| Hermes | `hermes skills install crawlerpeek/crawlerpeek/skills/crawlerpeek` |

```sh
git clone --depth 1 https://github.com/crawlerpeek/crawlerpeek.git
mkdir -p ~/.agents/skills && cp -r crawlerpeek/skills/crawlerpeek ~/.agents/skills/
```

Restart the agent afterwards so it picks up the new skill. The skill and the MCP server are independent: with the MCP server connected the skill uses its tools, otherwise it runs `npx -y crawlerpeek`.

## GitHub Action

A composite action lives in `action/`; see `action/README.md`.

```yaml
- uses: crawlerpeek/crawlerpeek/action@v0
  with: { url: "https://example.com", fail-on: blocked }
```

## What you should know

- **see-as-bot sends the bot's own user-agent string from your machine.** It is not the real bot and not from the operator's IP ranges. Sites that verify bot IPs (Googlebot, GPTBot and others publish theirs) may treat a request that only claims to be the bot differently, often by blocking it. A 403 for `Googlebot` here can therefore be normal; a 403 for an unusual bot with a 200 for a browser usually points at a WAF or CDN rule. `robots.txt` itself is fetched with an honest `crawlerpeek/<version>` user agent.
- Google-Extended and Applebot-Extended are robots.txt control tokens, not crawlers: they get a robots.txt decision but are never fetched.
- Pages are fetched as raw HTML. No JavaScript runs.
- robots.txt is a request, not access control. Some user-triggered fetchers (ChatGPT-User, Perplexity-User) may not follow it; the operators' documentation says which.
- The bot list and user-agent strings come from the operators' documentation and can drift; the list was last compared with the operators' documentation on 2026-10-18.

## Safety limits

One request per bot plus one for robots.txt, sequential with a 300 ms pause (`--delay`); 10 s timeout for the whole request chain; at most 5 redirects, each re-checked (a redirect to a refused target is reported for that bot or for robots.txt, it does not stop the run); response bodies capped at 2 MB; no cookies. Private, loopback, link-local and metadata addresses are refused after DNS resolution (and again at connect time), as are ports other than 80 and 443 and URLs with credentials. `--allow-private` (CLI and `crawlerpeek mcp`) or `allowPrivate: true` lifts these limits for local testing.

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
