// SPDX-License-Identifier: Apache-2.0
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCrunchyrollSeriesUrl, parseCrunchyrollWatchUrl } from "../crunchyroll";
import { VideoCookieVault, videoCookieHeader, type BrowserVideoCookie } from "../video-cookies";

const WATCHLIST_URL = "https://www.crunchyroll.com/fr/watchlist";
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
type WatchlistFetcher = (input: URL, init: RequestInit) => Promise<Response>;

async function fetchWatchlistWithNativeCurl(input: URL, init: RequestInit): Promise<Response> {
  if (!Bun.Curl.available) return fetch(input, init);
  const headers = Object.entries(init.headers as Record<string, string>).map(([name, value]) => `${name}: ${value}`);
  const result = await Bun.Curl.request(input.href, {
    method: "GET",
    headers,
    timeout: 20_000,
    maxBytes: MAX_PAGE_BYTES,
    followRedirects: false,
    signal: init.signal ?? undefined,
  });
  const responseHeaders = new Headers();
  for (const line of result.headers.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) responseHeaders.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return new Response(result.body, { status: result.status, headers: responseHeaders });
}

export interface WatchlistEntry {
  url: string;
  title: string | null;
}

function entryFromHref(href: string, baseUrl: string): WatchlistEntry | null {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== "https://www.crunchyroll.com" || url.search || url.hash) return null;
  try {
    const parsed = parseCrunchyrollSeriesUrl(url);
    return { url: `https://www.crunchyroll.com/series/${parsed.contentId}`, title: null };
  } catch {
    try {
      const parsed = parseCrunchyrollWatchUrl(url);
      return { url: `https://www.crunchyroll.com/watch/${parsed.contentId}`, title: null };
    } catch {
      return null;
    }
  }
}

export async function parseWatchlistPage(html: string, baseUrl = WATCHLIST_URL): Promise<WatchlistEntry[]> {
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new RangeError("Watchlist page exceeds 16 MiB");
  const entries: WatchlistEntry[] = [];
  let active: WatchlistEntry | undefined;
  const rewritten = new HTMLRewriter()
    .on("a", {
      element(element) {
        const href = element.getAttribute("href");
        active = href ? (entryFromHref(href, baseUrl) ?? undefined) : undefined;
        if (active) entries.push(active);
        element.onEndTag(() => {
          active = undefined;
        });
      },
      text(text) {
        if (active) active.title = `${active.title ?? ""}${text.text}`.slice(0, 512);
      },
    })
    .transform(new Response(html));
  await rewritten.text();

  const unique = new Map<string, WatchlistEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.url)) unique.set(entry.url, { ...entry, title: entry.title?.trim() || null });
  }
  if (unique.size > MAX_ENTRIES) throw new RangeError("Watchlist has more than 10,000 entries");
  return [...unique.values()];
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new RangeError("Watchlist page exceeds 16 MiB");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) throw new RangeError("Watchlist page exceeds 16 MiB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function fetchWatchlistPage(
  cookies: readonly BrowserVideoCookie[],
  fetcher: WatchlistFetcher = fetchWatchlistWithNativeCurl,
  signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<{ url: string; status: number; html: string }> {
  let url = new URL(WATCHLIST_URL);
  let response: Response | undefined;
  for (let hop = 0; hop < 4; hop++) {
    signal.throwIfAborted();
    response = await fetcher(url, {
      headers: {
        Cookie: videoCookieHeader(cookies, url.href),
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
      },
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("crunchyroll-redirect-without-location");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || !["www.crunchyroll.com", "crunchyroll.com"].includes(next.hostname))
      throw new Error("crunchyroll-external-redirect-refused");
    url = next;
    await response.body?.cancel();
  }
  if (!response) throw new Error("crunchyroll-response-unavailable");
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`crunchyroll-http-${response.status}`);
  }
  const html = await readBoundedBody(response);
  if (!/watchlist/i.test(html)) throw new Error("crunchyroll-watchlist-page-marker-missing");
  return { url: url.href, status: response.status, html };
}

export async function collectAndExportWatchlist(
  options: {
    shenronRoot?: string;
    fetcher?: WatchlistFetcher;
    signal?: AbortSignal;
  } = {},
) {
  using vault = new VideoCookieVault();
  const cookies = await vault.load();
  const page = await fetchWatchlistPage(cookies, options.fetcher, options.signal);
  const entries = await parseWatchlistPage(page.html, page.url);
  if (!entries.length) throw new Error("crunchyroll-watchlist-items-not-found");
  const observedAt = new Date().toISOString();
  const payload = {
    schema: "crunchyroll-watchlist-export/v1",
    observedAt,
    source: { url: page.url, status: page.status, authenticationQualified: false },
    runtime: {
      version: Bun.version,
      revision: Bun.revision,
      features: {
        crawl: Bun.Crawl.available,
        curl: Bun.Curl.available,
        video: Bun.Video.available,
      },
    },
    entryCount: entries.length,
    entries,
    credentialValuesExported: false,
    mediaDownloaded: false,
    publicationPerformed: false,
  };
  const shenronRoot = resolve(options.shenronRoot ?? "C:/shenron");
  const home = join(shenronRoot, "data", "home");
  await mkdir(home, { recursive: true });
  const actualHome = await realpath(home);
  const destinationDirectory = join(actualHome, "imports");
  await mkdir(destinationDirectory, { recursive: true });
  if ((await realpath(destinationDirectory)) !== destinationDirectory)
    throw new Error("shenron-import-directory-must-not-be-a-symlink");
  const output = join(destinationDirectory, `crunchyroll-watchlist-${observedAt.replaceAll(/[:.]/g, "-")}.json`);
  if (await Bun.file(output).exists()) throw new Error("shenron-export-file-already-exists");
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  await Bun.write(output, bytes, { mode: 0o600 });
  return {
    output,
    entries: entries.length,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    authenticationQualified: false,
    runtime: payload.runtime,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await collectAndExportWatchlist()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown-error";
    console.error(JSON.stringify({ error: message.startsWith("crunchyroll-") ? message : "watchlist-export-failed" }));
    process.exitCode = 1;
  }
}
