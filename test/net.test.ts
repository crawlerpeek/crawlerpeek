import { createServer, type Server } from "node:http";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedGet } from "../src/net.js";

const robots = "User-agent: *\nDisallow: /private/\n";
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    // Answers compressed although the client asks for identity, as some CDNs do.
    if (req.url === "/gzip") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(gzipSync(robots)); return; }
    if (req.url === "/br") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" }); res.end(brotliCompressSync(robots)); return; }
    if (req.url === "/bomb") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024, 65))); return; }
    res.writeHead(200, { "content-type": "text/plain" }); res.end(robots);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("guardedGet over the built-in transport", () => {
  const opts = { userAgent: "test", allowPrivate: true };
  it("decodes gzip and brotli bodies the server sends without being asked", async () => {
    expect((await guardedGet(`${base}/gzip`, opts)).body).toBe(robots);
    expect((await guardedGet(`${base}/br`, opts)).body).toBe(robots);
    expect((await guardedGet(`${base}/plain`, opts)).body).toBe(robots);
  });
  it("caps the decoded size", async () => {
    const r = await guardedGet(`${base}/bomb`, { ...opts, maxBytes: 1000 });
    expect(r.bytes).toBe(1000);
    expect(r.truncated).toBe(true);
  });
});
