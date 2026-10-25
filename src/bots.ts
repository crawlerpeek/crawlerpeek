/**
 * Bot catalogue. Every entry links the operator's own documentation; changes need such a source (see CONTRIBUTING.md).
 * Bot catalogue last compared with the operators' documentation on 2026-10-18.
 */
export type BotKind = "training" | "search" | "user" | "control" | "classic" | "seo" | "social";

export type Bot = {
  slug: string;
  /** robots.txt user-agent token, as the operator documents it. */
  token: string;
  name: string;
  owner: string;
  kind: BotKind;
  /** User-agent string sent by seeAsBot. null for control tokens (Google-Extended, Applebot-Extended): they never make requests. */
  ua: string | null;
  docs: string | null;
};

export const CATALOGUE_CHECKED = "2026-10-18";

export const BOTS: Bot[] = [
  { slug: "gptbot", token: "GPTBot", name: "GPTBot", owner: "OpenAI", kind: "training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot", docs: "https://developers.openai.com/api/docs/bots" },
  { slug: "oai-searchbot", token: "OAI-SearchBot", name: "OAI-SearchBot", owner: "OpenAI", kind: "search", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot", docs: "https://developers.openai.com/api/docs/bots" },
  { slug: "chatgpt-user", token: "ChatGPT-User", name: "ChatGPT-User", owner: "OpenAI", kind: "user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", docs: "https://developers.openai.com/api/docs/bots" },
  { slug: "claudebot", token: "ClaudeBot", name: "ClaudeBot", owner: "Anthropic", kind: "training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", docs: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler" },
  { slug: "claude-searchbot", token: "Claude-SearchBot", name: "Claude-SearchBot", owner: "Anthropic", kind: "search", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)", docs: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler" },
  { slug: "claude-user", token: "Claude-User", name: "Claude-User", owner: "Anthropic", kind: "user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", docs: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler" },
  { slug: "perplexitybot", token: "PerplexityBot", name: "PerplexityBot", owner: "Perplexity", kind: "search", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", docs: "https://docs.perplexity.ai/guides/bots" },
  { slug: "perplexity-user", token: "Perplexity-User", name: "Perplexity-User", owner: "Perplexity", kind: "user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", docs: "https://docs.perplexity.ai/guides/bots" },
  { slug: "google-extended", token: "Google-Extended", name: "Google-Extended", owner: "Google", kind: "control", ua: null, docs: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers" },
  { slug: "applebot-extended", token: "Applebot-Extended", name: "Applebot-Extended", owner: "Apple", kind: "control", ua: null, docs: "https://support.apple.com/en-us/119829" },
  { slug: "ccbot", token: "CCBot", name: "CCBot", owner: "Common Crawl", kind: "training", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)", docs: "https://commoncrawl.org/ccbot" },
  { slug: "meta-externalagent", token: "meta-externalagent", name: "meta-externalagent", owner: "Meta", kind: "training", ua: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  { slug: "bytespider", token: "Bytespider", name: "Bytespider", owner: "ByteDance", kind: "training", ua: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", docs: null },
  { slug: "googlebot", token: "Googlebot", name: "Googlebot", owner: "Google", kind: "classic", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", docs: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers" },
  { slug: "bingbot", token: "Bingbot", name: "Bingbot", owner: "Microsoft", kind: "classic", ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", docs: "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0" },
  { slug: "applebot", token: "Applebot", name: "Applebot", owner: "Apple", kind: "classic", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", docs: "https://support.apple.com/en-us/119829" },
  { slug: "meta-externalfetcher", token: "meta-externalfetcher", name: "meta-externalfetcher", owner: "Meta", kind: "user", ua: "meta-externalfetcher/1.1", docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  { slug: "duckassistbot", token: "DuckAssistBot", name: "DuckAssistBot", owner: "DuckDuckGo", kind: "user", ua: "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)", docs: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot" },
  { slug: "amazonbot", token: "Amazonbot", name: "Amazonbot", owner: "Amazon", kind: "training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36", docs: "https://developer.amazon.com/amazonbot" },
  { slug: "ahrefsbot", token: "AhrefsBot", name: "AhrefsBot", owner: "Ahrefs", kind: "seo", ua: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", docs: "https://ahrefs.com/robot" },
  { slug: "semrushbot", token: "SemrushBot", name: "SemrushBot", owner: "Semrush", kind: "seo", ua: "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", docs: "https://www.semrush.com/bot/" },
  { slug: "mj12bot", token: "MJ12bot", name: "MJ12bot", owner: "Majestic", kind: "seo", ua: "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", docs: "https://www.mj12bot.com/" },
  { slug: "facebookexternalhit", token: "facebookexternalhit", name: "facebookexternalhit", owner: "Meta", kind: "social", ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  { slug: "slackbot", token: "Slackbot", name: "Slackbot", owner: "Slack", kind: "social", ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", docs: "https://api.slack.com/robots" },
];

/** Checked when no `bots` option is given: the AI crawlers site owners ask about most, plus Googlebot and Bingbot. */
export const DEFAULT_BOT_TOKENS: string[] = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User",
  "Google-Extended", "Googlebot", "Bingbot", "Applebot-Extended", "CCBot", "meta-externalagent", "Bytespider",
];
