// SPDX-License-Identifier: MIT
/**
 * Crunchyroll recon: maps what the public web app serves, with Bun's network APIs only.
 *
 * It reads the public HTML shell of the pages it is given, downloads the public JavaScript and CSS those pages link
 * (the Next.js build served from /build/_next/static), and extracts from them the API hosts and endpoint paths the web
 * app calls, the page route table, the design tokens (custom properties, colours, fonts) and the asset inventory.
 * It reads public files only: no sign-in, no token, no cookie. A Cloudflare challenge is classified and reported as
 * `challenge`; it is never solved or bypassed, and the pages behind it are simply absent from the map.
 */
import { createHash } from "node:crypto";

export const CRUNCHYROLL_ORIGIN = "https://www.crunchyroll.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export type PageState = "open" | "challenge" | "unreachable";

export function classifyResponse(status: number, headers: Headers, html: string): PageState {
  if (headers.get("cf-mitigated") === "challenge" || /<title>(?:Just a moment|Un instant)/i.test(html))
    return "challenge";
  if (status === 403 || status === 429) return "challenge";
  return status >= 200 && status < 400 ? "open" : "unreachable";
}

export interface PageRecon {
  url: string;
  status: number;
  state: PageState;
  title: string | null;
  lang: string | null;
  scripts: string[];
  styles: string[];
  hosts: string[];
  /** The client that obtained the page. */
  via?: ReconTier;
}

/** Script, stylesheet and host references of an HTML shell, resolved against its URL. */
export function extractPage(html: string, url: string): Omit<PageRecon, "status" | "state"> {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const hosts = new Set<string>();
  const resolve = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return new URL(value, url).href;
    } catch {
      return undefined;
    }
  };
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) scripts.add(resolve(match[1])!);
  for (const match of html.matchAll(/<link[^>]+rel="preload"[^>]*as="script"[^>]*href="([^"]+)"/g))
    scripts.add(resolve(match[1])!);
  for (const match of html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)) styles.add(resolve(match[1])!);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"[^>]*rel="stylesheet"/g))
    styles.add(resolve(match[1])!);
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]*crunchyroll[a-z0-9.-]*/gi))
    hosts.add(match[0].toLowerCase());
  return {
    url,
    title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? null,
    lang: /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1] ?? null,
    scripts: [...scripts].filter(Boolean),
    styles: [...styles].filter(Boolean),
    hosts: [...hosts].sort(),
  };
}

export interface Endpoint {
  host: string | null;
  path: string;
  kind: "content" | "auth" | "account" | "playback" | "discover" | "other";
}

const PATH_FAMILIES: [RegExp, Endpoint["kind"]][] = [
  [/^\/content\/v\d+\//, "content"],
  [/^\/auth\/v\d+\//, "auth"],
  [/^\/accounts\/v\d+\//, "account"],
  [/^\/(?:playback|drm)\/v\d+\//, "playback"],
  [/^\/(?:discover|recommendations|search)\b/, "discover"],
];

/** API paths and absolute API URLs found in string literals of a JavaScript bundle. */
export function extractEndpoints(js: string): Endpoint[] {
  const found = new Map<string, Endpoint>();
  const add = (host: string | null, raw: string) => {
    const path = raw
      .replace(/\$\{[^}]*\}/g, "{}")
      .replace(/\?.*$/, "")
      .replace(/[`'"\\)]+$/, "");
    if (path.length < 4 || path.length > 160 || /[\s<>]/.test(path)) return;
    const family = PATH_FAMILIES.find(([pattern]) => pattern.test(path));
    if (!family && host === null) return;
    found.set(`${host ?? ""}${path}`, { host, path, kind: family?.[1] ?? "other" });
  };
  for (const match of js.matchAll(
    /https?:\/\/([a-z0-9.-]*crunchyroll[a-z0-9.-]*(?:svc\.com)?)(\/[A-Za-z0-9_\-./{}$:%]*)?/gi,
  ))
    add(match[1]!.toLowerCase(), match[2] ?? "/");
  for (const match of js.matchAll(
    /["'`](\/(?:content|auth|accounts|playback|drm|discover|recommendations|search)\/[A-Za-z0-9_\-./{}$:%]*)["'`]/g,
  ))
    add(null, match[1]!);
  return [...found.values()].sort((a, b) => (a.host ?? "").localeCompare(b.host ?? "") || a.path.localeCompare(b.path));
}

/** Page routes of the Next.js build manifest or app router chunks: "/[locale]/watch/[id]" style patterns. */
export function extractRoutes(js: string): string[] {
  const routes = new Set<string>();
  for (const match of js.matchAll(
    /["'](\/(?:\[[a-zA-Z.]+\]|[a-z0-9-]+)(?:\/(?:\[\.{0,3}[a-zA-Z]+\]|[a-z0-9-]+))*)["']/g,
  )) {
    const route = match[1]!;
    if (
      route.includes("[") ||
      /^\/(?:watch|series|simulcastcalendar|videos|genres|news|search|discover|account|premium|games|store|manga|music|mylists|watchlist|history|crunchylists)\b/.test(
        route,
      )
    )
      routes.add(route);
  }
  return [...routes].sort();
}

export interface CssFacts {
  customProperties: Record<string, string>;
  colors: [string, number][];
  fontFamilies: string[];
  fontFiles: string[];
  mediaBreakpoints: string[];
}

export function extractCss(css: string): CssFacts {
  const customProperties: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]{1,120})[;}]/g))
    customProperties[match[1]!] ??= match[2]!.trim();
  const colorCounts = new Map<string, number>();
  for (const match of css.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const color = match[0].toLowerCase();
    colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
  }
  const families = new Set<string>();
  for (const match of css.matchAll(/font-family\s*:\s*([^;}{]{1,200})/g)) families.add(match[1]!.trim());
  const fontFiles = new Set<string>();
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\s*\)/g)) fontFiles.add(match[1]!);
  const breakpoints = new Set<string>();
  for (const match of css.matchAll(/@media[^{]*\((?:min|max)-width\s*:\s*([0-9.]+(?:px|em|rem))\)/g))
    breakpoints.add(match[1]!);
  return {
    customProperties,
    colors: [...colorCounts].sort((a, b) => b[1] - a[1]).slice(0, 40),
    fontFamilies: [...families].slice(0, 30),
    fontFiles: [...fontFiles].slice(0, 40),
    mediaBreakpoints: [...breakpoints].sort((a, b) => parseFloat(a) - parseFloat(b)),
  };
}

export interface AssetRecon {
  url: string;
  kind: "script" | "style";
  status: number;
  bytes: number;
  sha256: string | null;
  path: string | null;
}

export interface CrunchyrollMap {
  schema: "bun-video-crunchyroll-map/v1";
  generatedAt: string;
  origin: string;
  pages: PageRecon[];
  assets: AssetRecon[];
  hosts: string[];
  endpoints: Endpoint[];
  routes: string[];
  css: CssFacts;
  challenges: string[];
}

export type ReconTier = "fetch" | "lightpanda" | "obscura";

/** Runs a headless-browser CLI on a URL and returns the serialized DOM; null when the tool is absent or fails. */
async function renderWith(tier: Exclude<ReconTier, "fetch">, url: string): Promise<string | null> {
  const command =
    tier === "lightpanda"
      ? ["lightpanda", "fetch", "--dump", "html", url]
      : ["obscura", "fetch", url, "--dump", "html"];
  if (!Bun.which(command[0]!)) return null;
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 45_000);
    const html = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(timer);
    return html.length > 500 ? html : null;
  } catch {
    return null;
  }
}

export interface ReconOptions {
  /** Clients tried, in order, for a page the first fetch could not read. */
  tiers?: ReconTier[];
  pages: string[];
  /** Directory receiving the downloaded public assets; omitted = nothing is written. */
  cacheDir?: string;
  maxAssets?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const merge = (into: CssFacts, from: CssFacts) => {
  Object.assign(
    into.customProperties,
    Object.fromEntries(Object.entries(from.customProperties).filter(([key]) => !(key in into.customProperties))),
  );
  const colors = new Map(into.colors);
  for (const [color, count] of from.colors) colors.set(color, (colors.get(color) ?? 0) + count);
  into.colors = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 40);
  into.fontFamilies = [...new Set([...into.fontFamilies, ...from.fontFamilies])].slice(0, 30);
  into.fontFiles = [...new Set([...into.fontFiles, ...from.fontFiles])].slice(0, 40);
  into.mediaBreakpoints = [...new Set([...into.mediaBreakpoints, ...from.mediaBreakpoints])].sort(
    (a, b) => parseFloat(a) - parseFloat(b),
  );
};

export async function reconCrunchyroll(options: ReconOptions): Promise<CrunchyrollMap> {
  const doFetch = options.fetch ?? fetch;
  const get = async (url: string) => {
    const response = await doFetch(url, {
      headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" },
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    return response;
  };
  const map: CrunchyrollMap = {
    schema: "bun-video-crunchyroll-map/v1",
    generatedAt: new Date().toISOString(),
    origin: CRUNCHYROLL_ORIGIN,
    pages: [],
    assets: [],
    hosts: [],
    endpoints: [],
    routes: [],
    css: { customProperties: {}, colors: [], fontFamilies: [], fontFiles: [], mediaBreakpoints: [] },
    challenges: [],
  };
  const hosts = new Set<string>();
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const url of options.pages) {
    try {
      const response = await get(url);
      let html = await response.text();
      let state = classifyResponse(response.status, response.headers, html);
      let via: ReconTier = "fetch";
      // Each other client is tried as itself (no stealth, no challenge solving); a page that still answers with a
      // challenge is reported as such.
      for (const tier of (options.tiers ?? ["lightpanda", "obscura"]).filter(t => t !== "fetch") as Exclude<
        ReconTier,
        "fetch"
      >[]) {
        if (state === "open") break;
        const rendered = await renderWith(tier, url);
        if (rendered && !/<title>(?:Just a moment|Un instant)/i.test(rendered)) {
          html = rendered;
          state = "open";
          via = tier;
        }
      }
      if (state !== "open") {
        map.challenges.push(url);
        map.pages.push({
          url,
          status: response.status,
          state,
          title: null,
          lang: null,
          scripts: [],
          styles: [],
          hosts: [],
          via: "fetch",
        });
        continue;
      }
      const page = extractPage(html, url);
      map.pages.push({ ...page, status: response.status, state, via });
      page.scripts.forEach(s => scripts.add(s));
      page.styles.forEach(s => styles.add(s));
      page.hosts.forEach(h => hosts.add(h));
    } catch {
      map.pages.push({
        url,
        status: 0,
        state: "unreachable",
        title: null,
        lang: null,
        scripts: [],
        styles: [],
        hosts: [],
      });
    }
  }
  const queue = [
    ...[...scripts].map(url => ({ url, kind: "script" as const })),
    ...[...styles].map(url => ({ url, kind: "style" as const })),
  ].slice(0, options.maxAssets ?? 400);
  const endpoints = new Map<string, Endpoint>();
  const routes = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: options.concurrency ?? 8 }, async () => {
      while (next < queue.length) {
        const { url, kind } = queue[next++]!;
        try {
          const response = await get(url);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!response.ok || bytes.length > MAX_ASSET_BYTES) {
            map.assets.push({ url, kind, status: response.status, bytes: bytes.length, sha256: null, path: null });
            continue;
          }
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const text = new TextDecoder().decode(bytes);
          let path: string | null = null;
          if (options.cacheDir) {
            path = `${options.cacheDir}/${kind}s/${sha256.slice(0, 16)}-${new URL(url).pathname.split("/").pop() || "index"}`;
            await Bun.write(path, bytes);
          }
          map.assets.push({ url, kind, status: response.status, bytes: bytes.length, sha256, path });
          if (kind === "script") {
            for (const e of extractEndpoints(text)) endpoints.set(`${e.host ?? ""}${e.path}`, e);
            extractRoutes(text).forEach(r => routes.add(r));
            for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]*crunchyroll[a-z0-9.-]*/gi))
              hosts.add(match[0].toLowerCase());
          } else merge(map.css, extractCss(text));
        } catch {
          map.assets.push({ url, kind, status: 0, bytes: 0, sha256: null, path: null });
        }
      }
    }),
  );
  map.hosts = [...hosts].sort();
  map.endpoints = [...endpoints.values()].sort(
    (a, b) => (a.host ?? "").localeCompare(b.host ?? "") || a.path.localeCompare(b.path),
  );
  map.routes = [...routes].sort();
  map.assets.sort((a, b) => a.url.localeCompare(b.url));
  return map;
}

export function summarizeMap(map: CrunchyrollMap) {
  const count = <T>(items: T[], key: (item: T) => string) =>
    Object.fromEntries([...Map.groupBy(items, key)].map(([k, v]) => [k, v.length]));
  return {
    generatedAt: map.generatedAt,
    pages: map.pages.map(p => ({ url: p.url, state: p.state, status: p.status, title: p.title })),
    challenges: map.challenges.length,
    assets: {
      scripts: map.assets.filter(a => a.kind === "script").length,
      styles: map.assets.filter(a => a.kind === "style").length,
      bytes: map.assets.reduce((total, a) => total + a.bytes, 0),
    },
    hosts: map.hosts,
    endpointKinds: count(map.endpoints, e => e.kind),
    endpoints: map.endpoints.length,
    routes: map.routes.length,
    cssTokens: Object.keys(map.css.customProperties).length,
    cssColors: map.css.colors.length,
    fonts: map.css.fontFamilies.length,
  };
}
