import { describe, expect, test } from "bun:test";
import { parseCrawlReport, probeSource, probeSources } from "../src/web-probe";

describe("web probe", () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const range = request.headers.get("range");
      const body = new Uint8Array(1000).fill(7);
      if (range === "bytes=0-0") {
        return new Response(body.subarray(0, 1), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/1000" },
        });
      }
      return new Response(body, { headers: { "content-type": "video/mp4" } });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  test("reports range support, size and content type of a local source", async () => {
    const probe = await probeSource(`${base}/clip.mp4`);
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(206);
    expect(probe.acceptRanges).toBe(true);
    expect(probe.contentLength).toBe(1000);
    expect(probe.contentType).toBe("video/mp4");
    expect(probe.addresses).toContain("127.0.0.1");
    expect(probe.ok).toBe(true);
    expect(probe.tlsMs).toBeUndefined();
  });

  test("returns an error report instead of throwing on a closed port", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const probe = await probeSource(`http://127.0.0.1:${port}/x.mp4`);
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeString();
  });

  test("rejects non-HTTP schemes", async () => {
    await expect(probeSource("file:///etc/passwd")).rejects.toThrow("http(s)");
  });

  test("probes several sources in order", async () => {
    const probes = await probeSources([`${base}/a.mp4`, `${base}/b.mp4`], 2);
    expect(probes.map(probe => new URL(probe.url).pathname)).toEqual(["/a.mp4", "/b.mp4"]);
    expect(probes.every(probe => probe.ok)).toBe(true);
    server.stop(true);
  });
});

describe("crawl report", () => {
  test("accepts the aphrody-web crawl schema and rejects others", () => {
    const report = parseCrawlReport(
      JSON.stringify({ schema: "aphrody-web.crawl/1", pages: [{ url: "https://a.test/" }], errors: [], stats: {} }),
    );
    expect(report.pages[0]!.url).toBe("https://a.test/");
    expect(() => parseCrawlReport(JSON.stringify({ schema: "other", pages: [], errors: [] }))).toThrow(
      "unexpected crawl report schema",
    );
  });
});
