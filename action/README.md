# Crawlerpeek GitHub Action

Runs `npx crawlerpeek check` and fails the job when AI crawlers are blocked.

```yaml
name: ai-crawler-access
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: crawlerpeek/crawlerpeek/action@v0
        with:
          url: https://example.com
          bots: GPTBot,OAI-SearchBot,ClaudeBot,PerplexityBot
          fail-on: blocked
```

| Input | Default | |
| --- | --- | --- |
| `url` | required | Public URL to check |
| `bots` | 15 main bots | Comma-separated tokens or `all` |
| `fail-on` | `blocked` | `blocked`, `any-non-200` or `none` |
| `summary` | `true` | Append a Markdown table of the result to the job summary |
| `version` | `latest` | npm version of `crawlerpeek` |

The job summary shows the same result as a table (`check --summary-file`, crawlerpeek 0.3.0 or newer; a `version` pinned to 0.2 or older runs without it). Output `report`: the JSON result. The page is fetched from the GitHub runner with each bot's user-agent string, not from the operator's IP ranges; a site that verifies bot IPs may answer differently to the real bot.
