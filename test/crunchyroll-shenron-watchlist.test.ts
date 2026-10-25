// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { fetchWatchlistPage, parseWatchlistPage } from "../src/apps/crunchyroll-shenron-watchlist";
import type { BrowserVideoCookie } from "../src/video-cookies";

const cookie: BrowserVideoCookie = {
  name: "session",
  value: "fixture-only",
  domain: ".crunchyroll.com",
  path: "/",
  hostOnly: false,
  secure: true,
  httpOnly: true,
  session: true,
};

describe("private Crunchyroll watchlist export", () => {
  test("extracts canonical series and watch references, deduplicates, and omits unsafe links", async () => {
    const entries = await parseWatchlistPage(`
      <main data-testid="watchlist">
        <a href="/fr/series/G12345678/fixture?utm_source=private">Ignored query</a>
        <a href="/fr/series/G12345678/fixture"> One <span>Title</span> </a>
        <a href="/watch/G87654321/episode">Episode title</a>
        <a href="https://outside.example/series/G11111111">Outside</a>
        <a href="/fr/series/G22222222?token=not-exported">Signed</a>
      </main>
    `);
    expect(entries).toEqual([
      { url: "https://www.crunchyroll.com/series/G12345678", title: "One Title" },
      { url: "https://www.crunchyroll.com/watch/G87654321", title: "Episode title" },
    ]);
  });

  test("bounds redirects to Crunchyroll and binds cookies to the allowed host", async () => {
    let cookieHeader = "";
    const page = "<main>watchlist <a href='/series/G12345678'>A series</a></main>";
    const fetcher = async (input: URL, init?: RequestInit): Promise<Response> => {
      const url = input;
      cookieHeader = new Headers(init?.headers).get("cookie") ?? "";
      if (url.pathname === "/fr/watchlist")
        return new Response(null, { status: 302, headers: { location: "/fr/watchlist/" } });
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const result = await fetchWatchlistPage([cookie], fetcher);
    expect(new URL(result.url).pathname).toBe("/fr/watchlist/");
    expect(cookieHeader).toBe("session=fixture-only");
    expect(await parseWatchlistPage(result.html, result.url)).toEqual([
      { url: "https://www.crunchyroll.com/series/G12345678", title: "A series" },
    ]);
  });

  test("rejects authorization failures without retaining their response body", async () => {
    await expect(
      fetchWatchlistPage([cookie], async () => new Response("private-response-body", { status: 403 })),
    ).rejects.toThrow("crunchyroll-http-403");
  });

  test("refuses redirects outside the cookie origin", async () => {
    await expect(
      fetchWatchlistPage(
        [cookie],
        async () => new Response(null, { status: 302, headers: { location: "https://outside.example/" } }),
      ),
    ).rejects.toThrow("crunchyroll-external-redirect-refused");
  });
});
