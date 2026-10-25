#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from "node:path";
import { mkdir, symlink } from "node:fs/promises";
import { getHlsBrowserAssetPath } from "../hls";
import { loadJsonSecret } from "../secrets";
import {
  normalizeCookieExport,
  cookieHeader,
  rewritePlaylist,
  validateHlsConfig,
  redactUrl,
  type CookieBundle,
  parseCookieBundle,
} from "./hls-live-core";

const root = resolve(process.cwd());
const cookieFile = join(root, "cookie.json");
const hlsFile = join(root, "hls.json");
let args = Bun.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

async function prepare() {
  const source = option("--cookies-from");
  if (source) {
    if (await Bun.file(cookieFile).exists())
      throw new Error("cookie.json already exists; preserve the existing input.");
    const bundle = normalizeCookieExport(await Bun.file(resolve(source)).json());
    const home = Bun.env.USERPROFILE ?? Bun.env.HOME;
    if (!home) throw new Error("The protected owner cookie store is unavailable.");
    const store = join(home, ".aphrody/cookies/bun-video");
    const protectedFile = join(store, "cookie.json");
    if (await Bun.file(protectedFile).exists()) throw new Error("Protected cookie input already exists; preserve it.");
    await mkdir(store, { recursive: true });
    await Bun.write(protectedFile, JSON.stringify(bundle, null, 2) + "\n");
    await symlink(protectedFile, cookieFile, "file");
    console.log(JSON.stringify({ importedCookies: bundle.chromium.length, valuesLogged: false }));
  }
  if (!(await Bun.file(hlsFile).exists())) {
    await Bun.write(
      hlsFile,
      JSON.stringify(
        validateHlsConfig({
          src: option("--src") ?? null,
          pageUrl: option("--page"),
          config: { enableWorker: false },
        }),
        null,
        2,
      ) + "\n",
    );
  }
  if (!(await Bun.file(getHlsBrowserAssetPath()).exists()))
    throw new Error("Install the pinned bun-video dependencies before preparing the lab.");
}

async function loadCookies(): Promise<CookieBundle> {
  const secretName = option("--cookie-secret");
  if (secretName) {
    const stored = await loadJsonSecret({ service: "@aphrody/bun-video", name: secretName });
    if (stored === null) throw new Error("Configured cookie credential is missing from the OS trousseau.");
    return parseCookieBundle(stored);
  }
  let raw;
  try {
    raw = await Bun.file(cookieFile).json();
  } catch {
    throw new Error("Cookie input is unreadable.");
  }
  if (raw?.provider === "bun.secrets") {
    raw = await loadJsonSecret({ service: raw.service, name: raw.name });
    if (raw === null) throw new Error("Configured cookie credential is missing from the OS trousseau.");
  }
  return parseCookieBundle(raw);
}

async function selfCheck() {
  const assert = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message);
  };
  const synthetic = normalizeCookieExport([
    {
      name: "lab",
      value: "synthetic",
      domain: ".example.com",
      path: "/watch",
      secure: true,
      httpOnly: true,
      session: true,
      sameSite: "no_restriction",
    },
  ]);
  assert(
    cookieHeader(synthetic.chromium, new URL("https://www.example.com/watch/1")) === "lab=synthetic",
    "Cookie matching failed.",
  );
  assert(
    !cookieHeader(synthetic.chromium, new URL("https://evil-example.com/watch/1")),
    "Cookie domain isolation failed.",
  );
  assert(!cookieHeader(synthetic.chromium, new URL("https://example.com/watching")), "Cookie path isolation failed.");
  assert(!cookieHeader(synthetic.chromium, new URL("http://example.com/watch")), "Secure cookie isolation failed.");
  const nativeCookie = new Bun.Cookie(synthetic.bun[0]!);
  assert(nativeCookie.name === "lab" && nativeCookie.httpOnly, "Native Bun.Cookie failed.");
  const rewritten = rewritePlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.m4s\n',
    new URL("https://example.com/media/main.m3u8"),
    url => `/proxy/${encodeURIComponent(url)}`,
  );
  assert(
    rewritten.includes(encodeURIComponent("https://example.com/media/init.mp4")) &&
      rewritten.includes(encodeURIComponent("https://example.com/media/segment.m4s")),
    "HLS resource rewriting failed.",
  );
  const { attachHlsPlayback } = await import("../hls");
  const calls: string[] = [];
  class Decoder {
    static isSupported() {
      return true;
    }
    attachMedia() {
      calls.push("attach");
    }
    loadSource() {
      calls.push("load");
    }
    destroy() {
      calls.push("destroy");
    }
  }
  const playback = attachHlsPlayback({}, Decoder, {
    src: "https://example.com/main.m3u8",
    config: { enableWorker: false },
    beforeStart() {
      calls.push("listeners");
    },
  });
  playback.destroy();
  playback.destroy();
  assert(calls.join(",") === "listeners,attach,load,destroy", "Fork HLS lifecycle failed.");
  const { loadRemotionCore } = await import("../index");
  const { interpolate } = await loadRemotionCore();
  assert(interpolate(5, [0, 10], [0, 100]) === 50, "Bun video interpolation failed.");
  console.log(
    JSON.stringify({
      syntheticGates: "PASS",
      cookie: "Bun.Cookie",
      hls: "fork lifecycle and URI rewriting",
      video: "Remotion interpolation",
      realPlaybackQualified: false,
    }),
  );
}

/** Builds the HLS lab handler; `main` owns the listener, the web app mounts `handle` under `prefix`. */
export async function prepareHlsLab(argv = Bun.argv.slice(2)) {
  args = argv;
  if (args.includes("--help")) {
    console.log(
      "bun-video hls [--prepare --cookies-from <export.json> --page <watch URL> --src <m3u8>] [--check] [--probe] [--open] [--endpoint <loopback CDP websocket>]\nPrivate inputs: cookie.json and hls.json in the working directory. cookie.json may contain a bun.secrets reference instead of cookies; no plaintext fallback is used for that reference. --check runs synthetic gates and exits. --probe performs the configured page request and exits. Default serves the local player. Chrome cookies are imported only when --import-chrome and --endpoint are both supplied.",
    );
    return;
  }
  if (args.includes("--prepare")) await prepare();
  await selfCheck();
  if (args.includes("--check")) return;
  const cookies = await loadCookies();
  const selectedPage = option("--page");
  const config = selectedPage
    ? validateHlsConfig({ src: option("--src") ?? null, pageUrl: selectedPage, config: { enableWorker: false } })
    : validateHlsConfig(await Bun.file(hlsFile).json());
  let pageProbe: Record<string, unknown> = { configured: !!config.pageUrl };
  if (config.pageUrl) {
    const url = new URL(config.pageUrl);
    try {
      const response = await fetch(url, {
        headers: { Cookie: cookieHeader(cookies.chromium, url) },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      const html = response.status === 200 ? (await response.text()).slice(0, 4 * 1024 * 1024) : "";
      pageProbe = {
        url: redactUrl(url),
        status: response.status,
        contentType: response.headers.get("content-type"),
        manifestFound: /https?:[^\s"<>]+\.m3u8/.test(html),
        apiMigrationQualified: false,
      };
    } catch {
      pageProbe = { url: redactUrl(url), reachable: false, apiMigrationQualified: false };
    }
  }
  console.log(
    JSON.stringify({
      pageProbe,
      cookies: cookies.chromium.length,
      unexpiredCookies: cookies.chromium.filter(c => c.expires === undefined || c.expires > Date.now() / 1000).length,
      hlsSourceConfigured: !!config.src,
      realPlaybackQualified: false,
    }),
  );
  if (args.includes("--probe")) return;
  const hls = Bun.file(getHlsBrowserAssetPath());
  if (!(await hls.exists())) throw new Error("Run --prepare first to preload HLS.js.");
  const adapterBuild = await Bun.build({
    entrypoints: [join(root, "packages/bun-runtime-sdk/src/video/hls.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!adapterBuild.success) throw new Error("Fork HLS adapter bundling failed.");
  const html = await Bun.file(join(import.meta.dir, "hls-live.html")).text();
  const prefix = `/lab/${crypto.randomUUID()}`;
  const resources = new Map<string, string>();
  const register = (url: string) => {
    const id = crypto.randomUUID();
    resources.set(id, url);
    return `${prefix}/media/${id}`;
  };
  let manifestPath = config.src ? register(config.src) : null;
  const handle = async (req: Request): Promise<Response> => {
    {
      const requestURL = new URL(req.url);
      if (!requestURL.pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });
      const path = requestURL.pathname.slice(prefix.length);
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      };
      if (req.method === "GET" && (path === "/" || path === ""))
        return new Response(html, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      if (req.method === "GET" && path === "/hls.js")
        return new Response(hls, { headers: { ...headers, "Content-Type": "text/javascript" } });
      if (req.method === "GET" && path === "/adapter.js")
        return new Response(adapterBuild.outputs[0], {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (req.method === "GET" && path === "/status")
        return Response.json(
          {
            runtime: Bun.version,
            revision: Bun.revision,
            pageProbe,
            cookies: cookies.chromium.length,
            hlsVersion: "1.7.3",
            manifestPath,
            cdp: !!option("--endpoint"),
            realPlaybackQualified: false,
          },
          { headers },
        );
      if (req.method === "POST" && path === "/source") {
        if (req.headers.get("origin") !== requestURL.origin) return new Response("Origin rejected", { status: 403 });
        try {
          const next = validateHlsConfig({
            ...(await req.json()),
            config: { enableWorker: false },
            pageUrl: config.pageUrl,
          });
          if (!next.src) throw new Error("Source required.");
          await Bun.write(hlsFile, JSON.stringify(next, null, 2) + "\n");
          manifestPath = register(next.src);
          return Response.json({ manifestPath }, { headers });
        } catch {
          return new Response("Invalid HLS source", { status: 400 });
        }
      }
      if (req.method === "GET" && path.startsWith("/media/")) {
        const resource = resources.get(path.slice(7));
        if (!resource) return new Response("Unknown resource", { status: 404 });
        try {
          let target = new URL(resource);
          let response: Response | undefined;
          for (let attempt = 0; attempt < 6; attempt++) {
            if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
              throw new Error("Invalid media URL.");
            const forwarded = new Headers({ Cookie: cookieHeader(cookies.chromium, target) });
            if (req.headers.has("range")) forwarded.set("Range", req.headers.get("range")!);
            response = await fetch(target, {
              headers: forwarded,
              redirect: "manual",
              signal: AbortSignal.timeout(20000),
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || attempt === 5) throw new Error("Media redirect failed.");
            target = new URL(location, target);
          }
          if (!response) throw new Error("Media response missing.");
          const type = response.headers.get("content-type") ?? "application/octet-stream";
          if (response.ok && (target.pathname.endsWith(".m3u8") || /mpegurl/i.test(type))) {
            const playlist = await response.text();
            if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid HLS playlist.");
            return new Response(rewritePlaylist(playlist, target, register), {
              headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl" },
            });
          }
          const outgoing = new Headers({ ...headers, "Content-Type": type });
          for (const key of ["content-range", "accept-ranges", "content-length"])
            if (response.headers.has(key)) outgoing.set(key, response.headers.get(key)!);
          return new Response(response.body, { status: response.status, headers: outgoing });
        } catch {
          return new Response("Media fetch failed; no secrets logged", { status: 502 });
        }
      }
      return new Response("Not found", { status: 404 });
    }
  };
  return { handle, prefix, cookies };
}

export async function main(argv = Bun.argv.slice(2)) {
  const lab = await prepareHlsLab(argv);
  if (!lab) return;
  const { cookies } = lab;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: lab.handle });
  const url = new URL(`${lab.prefix}/`, server.url).href;
  console.log(`HLS lab ready: ${url}`);
  const endpoint = option("--endpoint");
  if (endpoint) {
    try {
      const { connect } = await import("bun:chromium");
      const connection = await connect(endpoint, { timeout: 10000 });
      try {
        await connection.send("Browser.getVersion");
        if (args.includes("--import-chrome"))
          await connection.send("Storage.setCookies", { cookies: cookies.chromium });
        await connection.send("Target.createTarget", { url });
        console.log("CDP connected; lab tab created.");
      } finally {
        connection.close();
      }
    } catch {
      console.log("CDP unavailable; real Chrome automation remains unqualified.");
    }
  } else if (args.includes("--open")) {
    const chrome = join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe");
    if (await Bun.file(chrome).exists()) {
      const child = Bun.spawn([chrome, url], { stdout: "ignore", stderr: "ignore" });
      child.unref();
    } else console.log("Chrome executable unavailable; open the local lab URL manually.");
  }
  const stop = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main)
  main().catch(() => {
    console.error("HLS lab failed; check local files and options. Secret values are omitted.");
    process.exitCode = 1;
  });

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = main;
