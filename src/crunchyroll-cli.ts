#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
import { createCrunchyrollApi, crunchyrollClientFactory } from "./crunchyroll-api";
import { parseCrunchyrollWatchUrl } from "./crunchyroll";
import {
  importCrunchyrollWatchlist,
  registerObservedCrunchyrollWatchlist,
  type CrunchyrollWatchlistEntry,
} from "./crunchyroll-watchlist";
import { createCrunchyrollService } from "./crunchyroll-service";
import { openConfiguredVideoCatalog } from "./video-neon-runtime";
import { CRUNCHYROLL_ORIGIN, reconCrunchyroll, summarizeMap, type CrunchyrollMap } from "./crunchyroll-recon";

export const CRUNCHYROLL_CLI_HELP = `Usage: bun-video crunchyroll help|watch <official URL>|serve [--hostname <host>] [--port <0..65535>]
       bun-video crunchyroll watchlist metadata|import <observed.json> [--catalog <path>] [--timeout <1..300000 ms>]
metadata registers supplied official series/watch references locally, including films, without authentication.
import expands supplied series via the existing configured client; watch references remain pending.
observed.json is an array of {"url":"official URL","title":"optional observed title"}, at most 4 MiB.
       bun-video crunchyroll recon [--out <dir>] [--page <URL>]...   map the public web app (pages, JS/CSS assets, endpoints, routes, design tokens)
       bun-video crunchyroll map|endpoints|routes|css|assets|hosts [--out <dir>]   print part of the last map
       bun-video crunchyroll page <URL>   render a page in Bun.WebView and print its title and links (reports a challenge)
recon reads public files only (no sign-in, token or cookie); a Cloudflare challenge is reported and never bypassed.
serve defaults to 127.0.0.1:3000 and public health/watch parsing only.
daemon [--hostname <host>] [--port <0..65535>] --entries <observed.json> [--catalog <path>] [--interval <60..86400 seconds>]
runs the sync loop, the catalog index, the metadata API and the /v1/resolve layer in one process until SIGTERM; the
entries file is re-read every cycle, and with BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN series are expanded to episodes.
Private metadata requires BUN_VIDEO_CRUNCHYROLL_API_TOKEN and a configured upstream access token.
No cookie/profile import, DRM processing or browser playback is performed by this API.
`;

export function parseCrunchyrollCli(args: string[]) {
  const command = args[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) return { command: "help" as const };
  if (command === "watchlist") {
    const operation = args[1],
      inputPath = args[2];
    if ((operation !== "metadata" && operation !== "import") || !inputPath || inputPath.startsWith("--"))
      throw new TypeError("watchlist requires metadata|import and an observed JSON path");
    let catalogPath: string | undefined,
      timeoutMs = 300000;
    const seen = new Set<string>();
    for (let index = 3; index < args.length; index++) {
      const flag = args[index]!,
        value = args[++index];
      if (!value || seen.has(flag)) throw new TypeError("Watchlist option requires one value");
      seen.add(flag);
      if (flag === "--catalog") catalogPath = value;
      else if (flag === "--timeout") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 300000)
          throw new RangeError("timeout must be 1..300000 milliseconds");
        timeoutMs = Number(value);
      } else throw new TypeError("Unknown watchlist option");
    }
    return { command: "watchlist" as const, operation, inputPath, catalogPath, timeoutMs };
  }
  if (command === "watch") {
    if (args.length !== 2) throw new TypeError("watch requires one official Crunchyroll URL");
    const result = parseCrunchyrollWatchUrl(args[1]!);
    const url = new URL(result.url);
    url.search = "";
    url.hash = "";
    return { command: "watch" as const, watch: { ...result, url: url.href } };
  }
  if (command === "daemon") {
    let hostname = "127.0.0.1",
      port = 3000,
      entriesPath: string | undefined,
      catalogPath: string | undefined,
      intervalSeconds = 900;
    for (let index = 1; index < args.length; index++) {
      const flag = args[index],
        value = args[++index];
      if (!value) throw new TypeError("CLI option requires a value");
      if (flag === "--hostname") {
        if (!/^[a-zA-Z0-9.:[\]-]+$/.test(value)) throw new TypeError("Invalid listen hostname");
        hostname = value;
      } else if (flag === "--port") {
        if (!/^\d+$/.test(value) || Number(value) > 65535) throw new RangeError("port must be 0..65535");
        port = Number(value);
      } else if (flag === "--entries") entriesPath = value;
      else if (flag === "--catalog") catalogPath = value;
      else if (flag === "--interval") {
        if (!/^\d+$/.test(value) || Number(value) < 60 || Number(value) > 86400)
          throw new RangeError("interval must be 60..86400 seconds");
        intervalSeconds = Number(value);
      } else throw new TypeError("Unknown daemon option");
    }
    if (!entriesPath) throw new TypeError("daemon requires --entries");
    return { command: "daemon" as const, hostname, port, entriesPath, catalogPath, intervalSeconds };
  }
  if (command !== "serve") throw new TypeError("Unknown Crunchyroll command");
  let hostname = "127.0.0.1",
    port = 3000;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index],
      value = args[++index];
    if (!value) throw new TypeError("CLI option requires a value");
    if (flag === "--hostname") {
      if (!/^[a-zA-Z0-9.:[\]-]+$/.test(value)) throw new TypeError("Invalid listen hostname");
      hostname = value;
    } else if (flag === "--port") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535)
        throw new RangeError("port must be 0..65535");
      port = Number(value);
    } else throw new TypeError("Unknown serve option");
  }
  return { command: "serve" as const, hostname, port };
}

const DEFAULT_RECON_PAGES = [
  `${CRUNCHYROLL_ORIGIN}/fr/`,
  `${CRUNCHYROLL_ORIGIN}/fr/series/GT00389311/dragon-ball-super-beerus`,
  `${CRUNCHYROLL_ORIGIN}/fr/watch/GE00389313JAJP/the-god-who-destroys`,
  `${CRUNCHYROLL_ORIGIN}/fr/videos/popular`,
  `${CRUNCHYROLL_ORIGIN}/fr/simulcastcalendar`,
  `${CRUNCHYROLL_ORIGIN}/fr/news`,
];

async function reconCommands(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  if (!command || !["recon", "map", "endpoints", "routes", "css", "assets", "hosts", "page"].includes(command))
    return false;
  const flag = (name: string) => rest.flatMap((value, index) => (value === name ? [rest[index + 1]!] : []));
  const out = flag("--out")[0] ?? `${process.env.HOME ?? "."}/.aphrody/crunchyroll`;
  const mapPath = `${out}/map.json`;
  if (command === "recon") {
    const pages = flag("--page");
    const map = await reconCrunchyroll({ pages: pages.length ? pages : DEFAULT_RECON_PAGES, cacheDir: out });
    await Bun.write(mapPath, JSON.stringify(map));
    console.log(JSON.stringify(summarizeMap(map), null, 2));
  } else if (command === "page") {
    const url = rest[0];
    if (!url) throw new TypeError("page requires a URL");
    parseUrlOnCrunchyroll(url);
    await using view = new (Bun as any).WebView({
      width: 1280,
      height: 900,
      backend: { type: "chrome", url: false, argv: ["--no-sandbox"] },
    });
    await view.navigate(url);
    await Bun.sleep(4000);
    const title = String(await view.evaluate("document.title"));
    const challenge = /just a moment|un instant/i.test(title);
    const links = challenge
      ? []
      : ((await view.evaluate("[...new Set([...document.links].map(a => a.href))].slice(0, 200)")) as string[]);
    console.log(JSON.stringify({ url, title, state: challenge ? "challenge" : "open", links }, null, 2));
  } else {
    const map = JSON.parse(await Bun.file(mapPath).text()) as CrunchyrollMap;
    const view = {
      map: summarizeMap(map),
      endpoints: map.endpoints,
      routes: map.routes,
      css: map.css,
      assets: map.assets,
      hosts: map.hosts,
    }[command as "map"];
    console.log(JSON.stringify(view, null, 2));
  }
  return true;
}

function parseUrlOnCrunchyroll(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "crunchyroll.com" || url.hostname.endsWith(".crunchyroll.com")))
    throw new TypeError("Only https://*.crunchyroll.com URLs are accepted");
  return url;
}

export async function crunchyrollCliMain(args = Bun.argv.slice(2)) {
  try {
    if (await reconCommands(args)) return;
    const options = parseCrunchyrollCli(args);
    if (options.command === "help") console.log(CRUNCHYROLL_CLI_HELP);
    else if (options.command === "watch") console.log(JSON.stringify(options.watch));
    else if (options.command === "daemon") {
      const accessToken = process.env.BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN;
      const clientFactory = accessToken
        ? crunchyrollClientFactory({
            accessToken,
            accountId: process.env.BUN_VIDEO_CRUNCHYROLL_ACCOUNT_ID,
            locale: process.env.BUN_VIDEO_CRUNCHYROLL_LOCALE,
          })
        : undefined;
      await using catalog = await openConfiguredVideoCatalog({ sqlitePath: options.catalogPath });
      const service = createCrunchyrollService({
        catalog,
        clientFactory,
        api: { clientFactory },
        apiToken: process.env.BUN_VIDEO_CRUNCHYROLL_API_TOKEN,
        intervalMs: options.intervalSeconds * 1000,
        loadEntries: async () => {
          const file = Bun.file(options.entriesPath);
          if (file.size > 4 * 1024 * 1024) throw new RangeError("Observed references exceed 4 MiB");
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.bytes()));
        },
      });
      const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: service.fetch });
      service.start();
      console.log(`Crunchyroll service listening on ${server.url.origin}`);
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await stopped.promise;
      await service.stop();
      await server.stop(true);
    } else if (options.command === "watchlist") {
      const file = Bun.file(options.inputPath);
      if (file.size > 4 * 1024 * 1024) throw new RangeError("Observed references exceed 4 MiB");
      const bytes = await file.bytes();
      if (bytes.length > 4 * 1024 * 1024) throw new RangeError("Observed references exceed 4 MiB");
      const entries: CrunchyrollWatchlistEntry[] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      await using catalog = await openConfiguredVideoCatalog({ sqlitePath: options.catalogPath });
      if (options.operation === "metadata")
        console.log(JSON.stringify(await registerObservedCrunchyrollWatchlist(catalog, entries)));
      else {
        const accessToken = process.env.BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN;
        if (!accessToken) throw new TypeError("Import requires an explicitly configured upstream access token");
        const result = await importCrunchyrollWatchlist(catalog, entries, {
          timeoutMs: options.timeoutMs,
          clientFactory: crunchyrollClientFactory({
            accessToken,
            accountId: process.env.BUN_VIDEO_CRUNCHYROLL_ACCOUNT_ID,
            locale: process.env.BUN_VIDEO_CRUNCHYROLL_LOCALE,
            timeoutMs: Math.min(options.timeoutMs, 30000),
          }),
        });
        console.log(JSON.stringify(result));
      }
    } else {
      const apiToken = process.env.BUN_VIDEO_CRUNCHYROLL_API_TOKEN;
      const accessToken = process.env.BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN;
      const handler = createCrunchyrollApi({
        apiToken,
        clientFactory: accessToken
          ? crunchyrollClientFactory({
              accessToken,
              accountId: process.env.BUN_VIDEO_CRUNCHYROLL_ACCOUNT_ID,
              locale: process.env.BUN_VIDEO_CRUNCHYROLL_LOCALE,
            })
          : undefined,
      });
      const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: handler });
      console.log(`Crunchyroll metadata API listening on ${server.url.origin}`);
      const stop = () => server.stop(true);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch {
    console.error("Crunchyroll CLI failed; check command options and explicit configuration");
    process.exitCode = 1;
  }
}

if (import.meta.main) await crunchyrollCliMain();

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = crunchyrollCliMain;
