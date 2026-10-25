#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { detectActiveChromeProfile, probeForkBrowserCapabilities } from "./crunchyroll-app";

const root = resolve(import.meta.dir, "../../assets");
const locales = ["fr", "en", "es", "pt", "de", "it", "ar", "ja", "ko", "hi", "ru"];
const assets = new Map<string, string>();
for (const [prefix, directory, files] of [
  ["pwa", "crunchyroll-pwa", ["index.html", "app.js", "styles.css", "locales.js", "manifest.webmanifest", "sw.js"]],
  ["extension", "crunchyroll-extension", ["manifest.json", "popup.html", "popup.js", "locales.js"]],
] as const) {
  for (const file of [...files, "icons/icon192.png", "icons/icon512.png"])
    assets.set(`/${prefix}/${file}`, resolve(root, directory, file));
}
for (const locale of locales)
  assets.set(
    `/extension/_locales/${locale}/messages.json`,
    resolve(root, "crunchyroll-extension", "_locales", locale, "messages.json"),
  );
assets.set("/pwa/", resolve(root, "crunchyroll-pwa/index.html"));

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** Fetch handler for the PWA and extension assets; host policy is applied by the caller. */
export function createCrunchyrollShortcutsHandler(): (request: Request) => Promise<Response> {
  return async request => {
    const url = new URL(request.url);
    const headers = new Headers({
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { ...Object.fromEntries(headers), Allow: "GET, HEAD" },
      });
    if (url.pathname === "/")
      return new Response(null, {
        status: 302,
        headers: { ...Object.fromEntries(headers), Location: "/pwa/" },
      });
    if (url.pathname === "/health")
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ service: "bun-crunchyroll-shortcuts" }), {
        headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
      });
    const path = assets.get(url.pathname);
    if (!path) return new Response("Not found", { status: 404, headers });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404, headers });
    headers.set("Content-Type", url.pathname.endsWith(".webmanifest") ? "application/manifest+json" : file.type);
    if (url.pathname === "/pwa/sw.js") headers.set("Service-Worker-Allowed", "/pwa/");
    return new Response(request.method === "HEAD" ? null : file, { headers });
  };
}

export async function startCrunchyrollShortcuts(options: { port?: number; hostname?: string } = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname))
    throw new Error("The shortcut server requires a loopback address.");
  const handler = createCrunchyrollShortcutsHandler();
  return Bun.serve({
    hostname,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!LOOPBACK_HOSTS.includes(url.hostname))
        return new Response("Invalid host", { status: 421, headers: { "Cache-Control": "no-cache" } });
      return handler(request);
    },
  });
}

export async function crunchyrollShortcutsMain(args = Bun.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "bun run ./src/apps/crunchyroll-shortcuts.ts [--port 8000] [--open] [--check]\nPWA: /pwa/ ; extension source: ../../assets/crunchyroll-extension relative to this module. OAuth requires separate owner configuration.",
    );
  } else {
    const portIndex = args.indexOf("--port");
    const port = args.includes("--check") ? 0 : portIndex < 0 ? 8000 : Number(args[portIndex + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
    const server = await startCrunchyrollShortcuts({ port });
    try {
      if (args.includes("--check")) {
        const [manifest, extension, browser] = await Promise.all([
          fetch(new URL("/pwa/manifest.webmanifest", server.url)).then(response => response.json()),
          fetch(new URL("/extension/manifest.json", server.url)).then(response => response.json()),
          probeForkBrowserCapabilities(),
        ]);
        console.log(
          JSON.stringify({
            manifest,
            extensionVersion: extension.manifest_version,
            browser,
            installationValidated: false,
            oauthLiveValidated: false,
          }),
        );
        server.stop(true);
      } else {
        const url = new URL("/pwa/", server.url).href;
        console.log(
          JSON.stringify({
            url,
            extensionDirectory: resolve(root, "crunchyroll-extension"),
            installationValidated: false,
          }),
        );
        if (args.includes("--open")) {
          const profile = await detectActiveChromeProfile();
          Bun.spawn(
            [
              profile.executable,
              `--user-data-dir=${profile.userDataDir}`,
              `--profile-directory=${profile.profileDirectory}`,
              url,
            ],
            { stdout: "ignore", stderr: "ignore" },
          ).unref();
        }
        process.on("SIGINT", () => server.stop(true));
        process.on("SIGTERM", () => server.stop(true));
      }
    } catch (error) {
      server.stop(true);
      throw error;
    }
  }
}

if (import.meta.main) await crunchyrollShortcutsMain();

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = crunchyrollShortcutsMain;
