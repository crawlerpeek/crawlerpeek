export type Route = { status?: number; body?: string; headers?: Record<string, string> };

/** Mock fetch: routes keyed by "<user-agent substring>|<url>" or just url; records every request. */
export function mockFetch(routes: Record<string, Route | ((ua: string) => Route)>) {
  const calls: { url: string; ua: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ua = String((init?.headers as Record<string, string>)["user-agent"]);
    calls.push({ url, ua });
    const r = routes[url];
    if (!r) throw new Error("no route " + url);
    const x = typeof r === "function" ? r(ua) : r;
    return new Response(x.body ?? "", { status: x.status ?? 200, headers: x.headers ?? { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}
export const publicResolve = async () => ["93.184.216.34"];
