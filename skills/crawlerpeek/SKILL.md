---
name: crawlerpeek
description: Check whether AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended and others) can access a website, using robots.txt plus live HTTP requests. Use when the user asks if AI crawlers or AI search can read their site, why ChatGPT, Claude or Perplexity does not see or cite a page, whether robots.txt or a firewall blocks AI bots, or wants to allow or block AI crawlers in robots.txt.
license: MIT
compatibility: Needs Node.js 20 or newer, network access and a shell (npx), or the crawlerpeek MCP server.
metadata:
  author: crawlerpeek
  version: "0.3.1"
  homepage: https://crawlerpeek.com/cli
---

# Crawlerpeek

Answers one question: can AI crawlers reach this page? For each bot it reports what robots.txt says and what the page actually returns when fetched with that bot's user-agent string. It only reads; it never changes a site.

## When to use

- "Can GPTBot / ClaudeBot / PerplexityBot read my site?"
- "Why doesn't ChatGPT (or Claude, Perplexity) see or cite this page?"
- "Is my robots.txt blocking AI crawlers?" or "Is my firewall / CDN blocking them?"
- "Write a robots.txt that allows (or blocks) AI bots."
- "Is there a mistake in my robots.txt?" (typos, rules in the wrong place, HTML served instead of robots.txt)
- "Does robots.txt block any page in my sitemap?" or "check my whole site, not one page"
- "Is this IP in my logs really Googlebot / GPTBot / ClaudeBot?"

Do not use it for general SEO audits, rankings, page speed or content quality.

## Run it

If the `crawlerpeek` MCP server is connected, use its tools `check_ai_access`, `see_as_bot`, `verify_bot_ip`, `lint_robots_txt`, `scan_site` and `generate_robots_txt` and skip the commands below. Otherwise use the CLI. Always pass a full URL with `https://`.

```sh
# All default bots for one URL: robots.txt decision plus HTTP status per bot
npx -y crawlerpeek check https://example.com/page --json

# One bot in detail (status, redirects, content type, size, title, block-page heuristic)
npx -y crawlerpeek see https://example.com/page --bot ClaudeBot

# Is an IP from the user's logs really the crawler it claims to be?
npx -y crawlerpeek verify 66.249.66.1 --bot Googlebot --json

# Find mistakes in a robots.txt: a site's /robots.txt, a file, or - for stdin
npx -y crawlerpeek lint https://example.com --json

# robots.txt per bot for the URLs in the sitemap (no pages are fetched)
npx -y crawlerpeek scan https://example.com --limit 50 --json

# Draft a robots.txt that names AI crawlers explicitly
npx -y crawlerpeek robots --disallow /admin/,/cart/ --sitemap https://example.com/sitemap.xml
```

Useful options for `check`: `--bots GPTBot,ClaudeBot` (or `all`), `--no-http` (robots.txt only, no page requests). Check the page the user cares about, not only the home page: robots.txt rules are per path. One run sends one request per bot plus one for robots.txt; do not loop it over many sites.

If there is no shell or network (for example a sandbox without npm access), say so and point the user to https://crawlerpeek.com instead of guessing.

## Read the result

In the `--json` output, per entry in `bots[]`:

| Field | Meaning |
| --- | --- |
| `robots.access` | `allowed`, `partial` (allowed for this path, other parts closed), `blocked`, or `unknown` (robots.txt could not be fetched, reason in `robotsTxt.error`) |
| `robots.pathAllowed` | `false` means robots.txt closes this path for the bot |
| `http.status`, `http.outcome` | `ok`, `blocked` (401/403/406/451 or a challenge page) or `error` (other status or failed request) |
| `http.looksBlocked`, `http.blockReason` | the page looks like a block or challenge page even if the status is 200 |
| `kind` | `training`, `search`, `user` (fetches on a user's behalf), `control` (robots.txt token only, never fetched), `classic` |

Interpret it:

- robots.txt blocked and HTTP 200: policy blocks the bot. Well-behaved crawlers obey it, the server does not enforce it. The fix is in robots.txt.
- robots.txt allowed and HTTP 403 or a challenge page: a firewall, CDN or bot-protection rule blocks the bot. robots.txt is not the cause; the fix is in the WAF or CDN settings.
- `unknown`: the robots.txt fetch failed. Treat it as a problem to fix. Many crawlers treat an unreachable robots.txt (5xx) as "disallow everything".
- A 200 with a short or empty page title can mean the content is rendered by JavaScript. Crawlerpeek does not run JavaScript, and many AI crawlers do not either.
- `lint`: each finding has a `code`, `severity` (`error`, `warning`, `info`) and `line`. Report errors and warnings; mention info findings only when relevant (for example `unsupported-directive` for `Crawl-delay`, which Google ignores). `unknown-agent` and `unknown-field` carry a "did you mean" hint, which is a suggestion, not a certainty. A missing robots.txt (404) has no findings and allows everything. Exit code 1 is a normal result (findings), not a tool error.
- `scan`: `summary.perBot[].blocked` counts the URLs robots.txt closes for that bot, `urls[].blockedFor` names the bots per URL. It reads robots.txt and the sitemap files only, so it says nothing about what the pages return; use `check` or `see` for that. Only same-host URLs of the first sitemaps are covered, up to `--limit` (max 200); `.gz` sitemaps are skipped (see `sitemaps[].error`).
- `control` bots (Google-Extended, Applebot-Extended) only get a robots.txt decision.
- `verify`: `verified: true` means the IP is in the operator's published list or passes forward-confirmed reverse DNS; `false` means every documented method says no, so the request only claimed the name; `null` means it could not be decided (no documented method, or a list could not be fetched). Never call an IP fake on `null`. Exit code 1 from `verify` is a normal result (not verified or undecided), not a tool error.

Limits to state when they matter:

- The bot's user-agent string is sent from the user's machine, not from the operator's IP ranges. Sites that verify bot IPs may answer the real bot differently. A 403 for `Googlebot` here can be normal; a 403 for an AI bot with a 200 for a browser usually points at a WAF or CDN rule.
- robots.txt is a request, not access control. Some user-triggered fetchers may not follow it.
- Training bots (for example GPTBot, ClaudeBot) and search or user bots (OAI-SearchBot, Claude-SearchBot, ChatGPT-User, Perplexity-User) are separate decisions. Blocking training does not stop AI search citations. Keep them apart in any recommendation.

More detail on fields and exit codes: [references/output.md](references/output.md).

## Safe defaults

- Only check public sites. Do not run it against private, internal or localhost hosts unless the user explicitly asks; then and only then add `--allow-private`. Without it such targets are refused.
- Do not edit the user's robots.txt or server config on your own. Show the proposed change as text and let the user apply it.
- Do not pass credentials in URLs; they are refused.

## Answer format

Give the verdict first, then the evidence, then the fix:

1. One line: which bots can and cannot reach the URL.
2. A short list per problem bot: `Bot: robots.txt allowed / HTTP 403 (block page)`, and the cause (robots.txt policy, firewall or CDN, JavaScript-only content, unreachable robots.txt).
3. The concrete fix, with a robots.txt snippet when the cause is robots.txt, and the limits above when they affect how far the result can be trusted.
