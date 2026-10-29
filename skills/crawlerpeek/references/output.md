# Crawlerpeek output reference

## `check --json`

Top level: `url`, `checkedAt`, `path`, `robotsTxt`, `bots`, `failOn`, `failed`.

`robotsTxt`: `url`, `state` (`ok`, `missing` for a 4xx answer, `unavailable` for 5xx, 429, an unfollowable redirect or a failed request), `status`, `error`, `sitemaps`. A missing robots.txt allows everything.

Each entry of `bots`: `bot`, `owner`, `kind`, `robots` (`access`, `pathAllowed`, `matchedGroup`), and `http` (`null` with `--no-http` and for control tokens): `fetched`, `status`, `finalUrl`, `redirects`, `contentType`, `bytes`, `truncated`, `title`, `looksBlocked`, `blockReason`, `outcome`, `error`.

## `lint --json`

Top level: `source` (the robots.txt URL, the file path or `stdin`), `status` and `state` (URLs only), `note`, `findings`, `counts` (`error`, `warning`, `info`), `failOn`, `failed`.

Each finding: `line` (`null` for whole-file findings), `severity`, `code`, `message`. Codes: `html-instead-of-robots`, `rule-before-user-agent`, `unknown-field`, `missing-colon`, `unsupported-directive`, `path-not-absolute`, `sitemap-not-absolute`, `unknown-agent`, `empty-group`, `duplicate-agent`, `all-ai-blocked`, `too-large`, `too-many-lines`, `findings-truncated`.

## `scan --json`

Top level: `site`, `checkedAt`, `robotsTxt` (as in `check`), `sitemaps` (`url`, `status`, `urls`, `error`), `urls` (`url`, `blockedFor`), `summary` (`urlsChecked`, `perBot[]` with `bot`, `blocked`), `failOn`, `failed`.

## Exit codes

`0` ok, `1` the `--fail-on` condition was met (`blocked` or `any-non-200`), `2` usage error or the request failed or was refused. `see` exits `0` whenever the page was fetched, whatever its HTTP status. `lint` exits `1` on warnings or errors (`--fail-on error` for errors only). `scan` exits `1` with `--fail-on blocked` when any checked bot is blocked from any URL, and `2` when no URL could be read from the sitemap. Without `--fail-on`, `check` exits `0` whatever the result, so read the output rather than the exit code.

## Limits of one run

`check`: one request per bot plus one for robots.txt, 300 ms apart, 10 s timeout, at most 5 redirects (each re-checked), bodies capped at 2 MB, no cookies, no JavaScript. `lint` sends one request; `scan` sends robots.txt plus at most 10 sitemap requests and never fetches pages.

Full documentation: https://crawlerpeek.com/cli
