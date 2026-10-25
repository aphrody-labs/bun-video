#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { getDashBrowserAssetPath, inspectDashManifest } from "../dash";
import { loadHarCapture } from "../har";
import { createDashLiveTransport, validateDashLiveConfig } from "./dash-live-core";

async function readPrivateLiveConfig(inputPath: string) {
  try {
    return validateDashLiveConfig(await Bun.file(resolve(inputPath)).json());
  } catch {
    throw new Error("Unable to read a valid private live DASH configuration.");
  }
}

export function prepareCapturedDash(xml: string, baseURL: string, localRoot: string) {
  const summary = inspectDashManifest(xml);
  if (
    summary.segmentTemplateCount ||
    /<(?:\w+:)?(?:SegmentList|Location|PatchLocation|UTCTiming|ContentSteering|Laurl|License)\b/i.test(xml)
  )
    throw new Error("This offline dashboard supports captured BaseURL/SegmentBase MPDs only.");
  const resources: string[] = [];
  const decode = (text: string) =>
    text.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, value => {
      const named: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      };
      if (named[value]) return named[value]!;
      const hex = /^&#x/i.test(value);
      return String.fromCodePoint(Number.parseInt(value.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
    });
  const rewritten = xml.replace(/<((?:\w+:)?BaseURL)\b[^>]*>([^<]*)<\/\1\s*>/g, (_all, name: string, body: string) => {
    const decoded = decode(body.trim());
    if (!/^https?:\/\//i.test(decoded)) throw new Error("Offline replay requires absolute captured BaseURLs.");
    const url = new URL(decoded, baseURL);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname.endsWith("/"))
      throw new Error("Unsupported captured media BaseURL.");
    const index = resources.push(url.href) - 1;
    return `<${name}>${localRoot}media/${index}</${name}>`;
  });
  if (!resources.length) throw new Error("Captured DASH manifest has no replayable BaseURL.");
  const withoutNamespaces = rewritten.replace(/\sxmlns(?::[\w-]+)?\s*=\s*(["']).*?\1/g, "");
  if (
    /https?:\/\//i.test(decode(withoutNamespaces.replaceAll(localRoot, ""))) ||
    /\b(?:href|sourceURL|media|initialization)\s*=/i.test(withoutNamespaces)
  )
    throw new Error("Offline manifest contains unsupported external resource references.");
  return { manifest: rewritten, resources, summary };
}

export interface DashLabOptions {
  readonly inputPath: string;
  readonly mode?: "capture" | "live";
  /** Public origin of the server that mounts this lab; manifest URLs are rewritten against it. */
  readonly origin: string;
  /** Path prefix ending in "/" under which the lab is mounted. */
  readonly prefix: string;
}

/** Builds the DASH lab handler without starting a server; the caller owns the listener. */
export async function createDashLab({ inputPath, mode = "capture", origin, prefix }: DashLabOptions) {
  if (!prefix.startsWith("/") || !prefix.endsWith("/")) throw new RangeError("Lab prefix must start and end with /");
  const capture = mode === "capture" ? await loadHarCapture(resolve(inputPath)) : null;
  const descriptor = capture?.selectManifest({ kind: "dash" });
  if (capture && !descriptor) throw new Error("No captured DASH manifest is available.");
  const live = mode === "live" ? createDashLiveTransport(await readPrivateLiveConfig(inputPath)) : null;
  const source = live ? await live.fetchSource() : null;
  const route = prefix;
  const browser = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../dash.ts")],
    target: "browser",
    format: "esm",
    external: ["dashjs"],
  });
  if (!browser.success) throw new Error("DASH browser adapter build failed.");
  const html = await Bun.file(resolve(import.meta.dir, "dash-live.html")).text();
  let prepared: {
    manifest: string;
    summary: ReturnType<typeof inspectDashManifest>;
    resources: string[];
  };
  const handle = async (request: Request): Promise<Response> => {
    {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(route)) return new Response(null, { status: 404 });
      const relative = url.pathname.slice(route.length);
      const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
      if (request.method !== "GET" && !(live && relative.startsWith("live/") && request.method === "HEAD"))
        return new Response(null, { status: 405 });
      if (!relative)
        return new Response(html, {
          headers: {
            ...headers,
            "Content-Type": "text/html",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
          },
        });
      if (relative === "dash.all.min.js")
        return new Response(Bun.file(getDashBrowserAssetPath()), {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (relative === "adapter.js")
        return new Response(browser.outputs[0], {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (relative === "dashboard.js")
        return new Response(dashboardCode, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (relative === "summary")
        return Response.json({
          ...prepared.summary,
          capturedOnly: !live,
          liveManifestConfigured: !!live,
          playbackValidated: false,
          drmLicenseValidated: false,
        });
      if (live && /^live\/[\da-f-]{36}$/.test(relative)) {
        try {
          const response = await live.fetchResource(relative.slice(5), request);
          response.headers.set("Cache-Control", "no-store");
          response.headers.set("Referrer-Policy", "no-referrer");
          return response;
        } catch {
          return new Response("Authorized upstream DASH request failed.", { status: 502, headers });
        }
      }
      if (relative === "manifest.mpd")
        return new Response(prepared.manifest, {
          headers: { ...headers, "Content-Type": "application/dash+xml" },
        });
      const match = /^media\/(\d+)$/.exec(relative);
      if (match) {
        const remoteURL = prepared.resources[Number(match[1])];
        if (!remoteURL) return new Response(null, { status: 404 });
        const resource = capture?.resourceForUrl(remoteURL);
        const response = resource
          ? capture!.replayResource(resource.entryIndex, request.headers.get("Range") ?? undefined)
          : null;
        return (
          response ??
          new Response("Requested range is absent from this offline capture.", {
            status: 404,
            headers,
          })
        );
      }
      return new Response(null, { status: 404 });
    }
  };
  const localRoot = `${origin}${route}`;
  if (live && source) {
    const urlForToken = (token: string) => `${localRoot}live/${token}`;
    prepared = {
      manifest: await live.rewriteDashManifest(source.text, source.baseURL, urlForToken),
      summary: inspectDashManifest(source.text),
      resources: [],
    };
  } else {
    prepared = prepareCapturedDash(
      capture!.readManifest(descriptor!.entryIndex),
      "https://offline.invalid/",
      localRoot,
    );
  }
  return { fetch: handle, url: `${origin}${route}`, summary: prepared.summary };
}

/** Standalone lab: one loopback server whose origin is known before the manifest is rewritten. */
export async function startDashLab(inputPath: string, mode: "capture" | "live" = "capture") {
  let lab: Awaited<ReturnType<typeof createDashLab>> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => (lab ? lab.fetch(request) : new Response(null, { status: 404 })),
  });
  try {
    lab = await createDashLab({
      inputPath,
      mode,
      origin: server.url.origin,
      prefix: `/lab/${crypto.randomUUID()}/`,
    });
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return { server, url: lab.url, summary: lab.summary };
}

const dashboardCode = `import { attachDashPlayback } from './adapter.js';
const video = document.querySelector('video');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const summary = await (await fetch('./summary')).json();
result.textContent = JSON.stringify(summary, null, 2);
status.textContent = summary.encrypted ? 'DASH chiffré : la licence reste au lecteur officiel. Lecture Bun non validée.' : 'DASH clair. Lance la lecture pour tester le navigateur.';
document.querySelector('#mode').textContent = summary.capturedOnly ? 'Rejeu des réponses capturées localement.' : 'Requêtes MPD et vidéo autorisées via le transport natif Bun.';
let playback;
document.querySelector('button').onclick = async () => {
  try {
    playback?.destroy();
    playback = await attachDashPlayback(video, { src: new URL('./manifest.mpd', location.href).href, autoplay: true,
      createPlayer: () => dashjs.MediaPlayer().create(),
      beforeStart(player) { player.on(dashjs.MediaPlayer.events.ERROR, event => { status.textContent = 'Erreur DASH locale (code ' + (Number(event.error?.code) || 0) + '). Plage absente ou licence requise ; lecture non validée.'; }); }
    });
  } catch { status.textContent = 'Initialisation DASH impossible ; lecture non validée.'; }
};
video.addEventListener('playing', () => { status.textContent = 'Le navigateur a commencé la lecture. Le test complet reste à qualifier.'; });
addEventListener('pagehide', () => playback?.destroy());
`;

export async function main(args = Bun.argv.slice(2)) {
  const liveIndex = args.indexOf("--live-config");
  if (args.includes("--help")) {
    console.log(
      "bun-video dash [--har <absolute HAR>] [--check] [--open]\nbun-video dash --live-config <protected JSON outside repository> [--check] [--open]\nLive mode fetches an explicitly authorized MPD and GET/HEAD media. DRM remains with the official player. --check prints metadata without source URLs or headers.",
    );
  } else if (liveIndex >= 0) {
    const configPath = args[liveIndex + 1];
    if (!configPath) throw new Error("--live-config requires a protected configuration path.");
    const path = resolve(configPath);
    const root = resolve(process.cwd());
    if (
      path.toLowerCase().startsWith(root.toLowerCase() + "/") ||
      path.toLowerCase().startsWith(root.toLowerCase() + "\\")
    )
      throw new Error("Private live configuration must be stored outside the repository.");
    if (args.includes("--check")) {
      const live = createDashLiveTransport(await readPrivateLiveConfig(path));
      const source = await live.fetchSource();
      const manifest = await live.rewriteDashManifest(
        source.text,
        source.baseURL,
        token => `http://127.0.0.1/lab/check/live/${token}`,
      );
      console.log(
        JSON.stringify({
          manifest: inspectDashManifest(manifest),
          mode: "live",
          playbackValidated: false,
          drmLicenseValidated: false,
        }),
      );
    } else {
      const lab = await startDashLab(path, "live");
      console.log(
        JSON.stringify({
          url: lab.url,
          summary: lab.summary,
          mode: "live",
          playbackValidated: false,
        }),
      );
      if (args.includes("--open")) {
        const chrome = resolve(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe");
        if (await Bun.file(chrome).exists())
          Bun.spawn([chrome, lab.url], { stdout: "ignore", stderr: "ignore" }).unref();
      }
      process.on("SIGINT", () => lab.server.stop(true));
      process.on("SIGTERM", () => lab.server.stop(true));
    }
  } else {
    const index = args.indexOf("--har");
    const input = index < 0 ? resolve(process.cwd(), "tmp/test/www.crunchyroll.com.har") : args[index + 1];
    if (!input) throw new Error("--har requires a file path.");
    if (args.includes("--check")) {
      const capture = await loadHarCapture(resolve(input));
      const descriptor = capture.selectManifest({ kind: "dash" });
      if (!descriptor) throw new Error("No captured DASH manifest is available.");
      const prepared = prepareCapturedDash(
        capture.readManifest(descriptor.entryIndex),
        "https://offline.invalid/",
        "http://127.0.0.1/lab/check/",
      );
      console.log(
        JSON.stringify({
          capture: capture.summary,
          manifest: prepared.summary,
          localMediaResourceCount: prepared.resources.length,
          playbackValidated: false,
          drmLicenseValidated: false,
        }),
      );
    } else {
      const lab = await startDashLab(input);
      console.log(JSON.stringify({ url: lab.url, summary: lab.summary, playbackValidated: false }));
      if (args.includes("--open")) {
        const chrome = resolve(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe");
        if (await Bun.file(chrome).exists())
          Bun.spawn([chrome, lab.url], { stdout: "ignore", stderr: "ignore" }).unref();
      }
      process.on("SIGINT", () => lab.server.stop(true));
      process.on("SIGTERM", () => lab.server.stop(true));
    }
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error("Video lab failed; check private inputs and options. Captured values are omitted.");
    process.exitCode = 1;
  });

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = main;
