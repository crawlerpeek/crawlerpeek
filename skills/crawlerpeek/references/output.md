# Crawlerpeek output reference

## `check --json`

Top level: `url`, `checkedAt`, `path`, `robotsTxt`, `bots`, `failOn`, `failed`.

`robotsTxt`: `url`, `state` (`ok`, `missing` for a 4xx answer, `unavailable` for 5xx, 429, an unfollowable redirect or a failed request), `status`, `error`, `sitemaps`. A missing robots.txt allows everything.

Each entry of `bots`: `bot`, `owner`, `kind`, `robots` (`access`, `pathAllowed`, `matchedGroup`), and `http` (`null` with `--no-http` and for control tokens): `fetched`, `status`, `finalUrl`, `redirects`, `contentType`, `bytes`, `truncated`, `title`, `looksBlocked`, `blockReason`, `outcome`, `error`.

## Exit codes

`0` ok, `1` the `--fail-on` condition was met (`blocked` or `any-non-200`), `2` usage error or the request failed or was refused. `see` exits `0` whenever the page was fetched, whatever its HTTP status. Without `--fail-on`, `check` exits `0` whatever the result, so read the output rather than the exit code.

## Limits of one run

One request per bot plus one for robots.txt, 300 ms apart, 10 s timeout, at most 5 redirects (each re-checked), bodies capped at 2 MB, no cookies, no JavaScript.

Full documentation: https://crawlerpeek.com/cli
