# Changelog

## 0.1.1

- Package metadata only; no code changes.

## 0.1.0

First release.

- `check`: robots.txt decision and live HTTP result per bot, with `--fail-on blocked | any-non-200` for CI.
- `see`: one bot in detail.
- `robots`: generate a robots.txt that names AI crawlers explicitly.
- Library API: `checkAiAccess`, `seeAsBot`, `generateRobotsTxt`, `failingBots`.
- MCP server over stdio (`crawlerpeek mcp`) with three read-only tools.
- Composite GitHub Action in `action/`.
