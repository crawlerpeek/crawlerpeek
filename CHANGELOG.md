# Changelog

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

[0.1.2]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/crawlerpeek/crawlerpeek/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/crawlerpeek/crawlerpeek/releases/tag/v0.1.0
