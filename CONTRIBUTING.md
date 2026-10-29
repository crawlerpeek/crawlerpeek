# Contributing

Bug reports and pull requests are welcome.

## Development

```sh
npm ci
npm run build
npm test
node dist/cli.js check https://example.com
```

The package has no runtime dependencies, and should keep it that way. Tests mock `fetch` and DNS (see `test/helpers.ts`), so they never touch the network.

## Bot list

`src/bots.ts` lists every bot with a link to the operator's documentation. A new bot or a changed user-agent string needs that link: entries are based on what operators publish, not on what shows up in logs. Open a "Bot list update" issue or a pull request that edits `src/bots.ts` and its tests.

## robots.txt behaviour

`src/robots.ts` follows RFC 9309. If you think a result is wrong, please include the robots.txt and the path in the issue, ideally with a reference to the RFC section or the documented behaviour of a major crawler.

## Linter findings

`src/lint.ts` reports only what RFC 9309 or Google's [robots.txt documentation](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) supports. A new check needs a reference to one of them, a stable kebab-case `code`, and tests for both the finding and the near misses that must not trigger it.
