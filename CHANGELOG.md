# Changelog

## 0.3.1 - 2026-10-29

- Fixed: responses that a server compresses although the request asks for `identity` (gzip, deflate, brotli) are decoded before parsing. www.forbes.com does this for its robots.txt; until now its rules were read as binary data. The 2 MB cap applies to the decoded body.
- Fixed: `lint` no longer calls real crawlers typos when they are one substituted letter away from a catalogue token (AmazonAdBot, CJBot, SlickBot). A token is reported as a likely typo when it has the same letters with different punctuation (`PerplexityUser`, `GPT-Bot`) or one missing, doubled or swapped letter (`GPTBott`, `GTPBot`).
- Added: `lint` reports `Content-Signal` (Cloudflare's Content Signals Policy) and `License` (RSL) as `extension-directive` instead of `unknown-field`.
- Added: `lint` reports a body that is not text as one `not-text` error instead of a finding per line.

## 0.3.0 - 2026-10-29

- Added: `crawlerpeek lint <url|file|->` and `lintRobotsTxt()` / `lintRobotsUrl()` check a robots.txt for mistakes: HTML served instead of robots.txt, misspelled fields and bot tokens (with a "did you mean" hint), rules before any User-agent, relative paths and sitemap URLs, duplicate or empty groups, directives Google ignores, and a file that blocks every AI crawler. Every finding has a stable `code`, a `severity` and a line number. Exit code `0` nothing at or above `--fail-on` (default `warning`), `1` findings, `2` usage or request error.
- Added: `crawlerpeek scan <url>` and `scanSite()` evaluate robots.txt for the URLs in a site's sitemap (from robots.txt, else `/sitemap.xml`; a sitemap index is followed one level) and report per bot which URLs are blocked. Same-host URLs only, `--limit` 1 to 200 (default 25), `.gz` sitemaps are skipped. No page is fetched: the only requests are robots.txt and at most 10 sitemap files. `--fail-on blocked` exits `1` when any checked bot is blocked from any URL.
- Added: MCP tools `lint_robots_txt` and `scan_site`.
- Added: `check --markdown` and `formatMarkdown()` print the result as a GitHub-flavoured Markdown table. `check --summary-file <path>` appends the same Markdown to a file in addition to the normal output.
- Changed: the GitHub Action writes that Markdown table to the job summary (input `summary`, default `true`). A `version` pinned to 0.2 or older runs without it.
- Changed: `crawlerpeek mcp` exposes six tools. The robots.txt fetch used by `check` is shared with `lint` and `scan` (`fetchRobots()`); `check` behaves as before.

## 0.2.0 - 2026-10-25

- Added: an agent skill in `skills/crawlerpeek/` that teaches AI agents when to check AI crawler access, which commands to run and how to read the result. One folder for Claude Code, Claude, Codex, OpenClaw and Hermes.
- Added: a Claude Code plugin and marketplace. `/plugin marketplace add crawlerpeek/crawlerpeek`, then `/plugin install crawlerpeek@crawlerpeek` installs the MCP server and the skill together.
- Added: a Claude Desktop extension (`crawlerpeek-<version>.mcpb`, attached to each release) that needs no separate Node.js install. `npm run build:mcpb` builds it.
- Added: one-click install links for Cursor and VS Code, and install commands for Claude Code and Codex, in the README.
- Added: `crawlerpeek verify <ip> [--bot GPTBot] [--json]` and `verifyBotIp()` tell you whether an IP address really belongs to a crawler, using only the operator's documented methods: published IP-range lists (Google, OpenAI, Anthropic, Perplexity, Bing, Apple, Common Crawl, DuckDuckGo, Ahrefs) and forward-confirmed reverse DNS (Google, Bing, Apple, Common Crawl, Ahrefs). Bots without a documented method report `method: "none"` and `verified: null`. Exit code `0` verified, `1` not verified or undecidable, `2` usage error.
- Added: MCP tool `verify_bot_ip`.

## 0.1.3 - 2026-10-25

- Fixed: robots.txt length limits count each percent-encoded octet as one character, so a long rule with non-ASCII characters (for example `Disallow: /` followed by 60 CJK characters) is no longer ignored after normalization.

## 0.1.2 - 2026-10-25

- Fixed: a crafted page could make the title extraction run for tens of seconds. It is now linear-time.
- Fixed: a redirect to a refused target (private address, bad scheme or port) no longer aborts the whole run. It is reported for that bot, or as `unknown` for robots.txt with the reason in `robotsTxt.error`. Only the URL you pass in can still fail the run.
- Fixed: robots.txt paths are compared after percent-encoding normalization (RFC 9309 §2.2.2), so rules such as `Disallow: /ü` or `/%7Efoo` match the way crawlers read them.
- Fixed: a 3xx robots.txt response without a `Location` header is reported as `unknown` instead of being parsed.
- Fixed: TypeScript types now resolve for both ESM and CommonJS consumers.
- Changed: unknown command-line options are an error (exit code 2) instead of being ignored, so a typo like `--failon` cannot silently pass a CI run. `--help` works after a command.
- Changed: `see` exits with 2 instead of 1 when the request fails, matching the other commands.
- Changed: the Applebot user-agent string is the full string from Apple's documentation.
- Added: the MCP server also speaks protocol version 2025-11-25, and answers a message that is not a JSON object with `-32600`.
- Added: `--delay` and `--fail-on none` are listed in `--help`.
- The GitHub Action writes its report to `$RUNNER_TEMP` instead of the workspace.
- `server.json` description shortened to the registry's 100 character limit.

## 0.1.1 - 2026-10-25

- Republished with corrected package metadata.

## 0.1.0 - 2026-10-25

First release.

- `check`: robots.txt decision and live HTTP result per bot, with `--fail-on blocked | any-non-200` for CI.
- `see`: one bot in detail.
- `robots`: generate a robots.txt that names AI crawlers explicitly.
- Library API: `checkAiAccess`, `seeAsBot`, `generateRobotsTxt`, `failingBots`.
- MCP server over stdio (`crawlerpeek mcp`) with three read-only tools.
- Composite GitHub Action in `action/`.

[0.3.1]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/crawlerpeek/crawlerpeek/releases/tag/v0.1.0
