#!/usr/bin/env bun
import { realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { EpisodeManifest } from "./manifest";
import type { FrameAnalyzer, FrameMetrics } from "./frame-metrics";
import { rehydrateEpisodeVolume, type EpisodePackageManifest } from "../../episode-assets";

const mediaTypes: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  vtt: "text/vtt; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  flac: "audio/flac",
  wav: "audio/wav",
  gz: "application/gzip",
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  sha256: "text/plain; charset=utf-8",
};

function safeRelative(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.includes(":") &&
    path.split("/").every(part => part !== ".." && part !== "." && !!part)
  );
}

function contains(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function allowedAsset(manifest: EpisodeManifest, path: string): boolean {
  const files = [
    manifest.source?.file,
    manifest.poster,
    manifest.compression?.file,
    ...(manifest.storyboard ?? []).map(item => item.file),
    ...(manifest.highlights ?? []).flatMap(item => [item.file, item.poster]),
    ...(manifest.characters ?? []).map(item => item.icon),
    ...(manifest.subtitles ?? []).map(item => item.file),
    manifest.package?.manifest,
    manifest.package?.index,
    manifest.package?.readme,
    manifest.package?.checksums,
    ...(manifest.package?.volumes ?? []).map(item => item.file),
    manifest.dataset?.manifest,
    ...(manifest.dataset?.files ?? []),
    ...(manifest.dataset?.previews ?? []).map(item => (typeof item === "string" ? item : item.file)),
    manifest.pixelSVG?.manifest,
    ...(manifest.pixelSVG?.entries ?? []).flatMap(item => [item.svg, item.referencePNG]),
    manifest.themes?.manifest,
    ...(manifest.themes?.files ?? []),
  ];
  if (files.includes(path)) return true;
  if (!manifest.frames || !safeRelative(manifest.frames.directory)) return false;
  const prefix = `${manifest.frames.directory}/`;
  const escaped = manifest.frames.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${escaped.replace(/%0?(\d*)d/, (_, width) => (width ? `\\d{${Number(width)}}` : "\\d+"))}$`,
  );
  const filename = path.slice(prefix.length);
  const index = Number(filename.match(/\d+/)?.[0]);
  return path.startsWith(prefix) && pattern.test(filename) && index >= 1 && index <= manifest.frames.count;
}

export function byteRange(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return;
  if (!match[1]) {
    const length = Number(match[2]);
    return Number.isSafeInteger(length) && length > 0
      ? { start: Math.max(0, size - length), end: size - 1 }
      : undefined;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start
    ? { start, end }
    : undefined;
}

const document = `<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content=""><title>Bun Video · Atelier épisode</title><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`;

type EpisodeServerOptions = {
  episodeDir: string;
  port?: number;
  /** false mounts the handler in another server; no listener is started. */
  listen?: boolean;
  bundle?: boolean;
  chromiumExecutable?: string;
  analyzeFrame?: FrameAnalyzer;
  rehydrateVolume?: typeof rehydrateEpisodeVolume;
};
type EpisodeHandler = { fetch: (request: Request) => Promise<Response> };

export function createEpisodeServer(options: EpisodeServerOptions & { listen?: true }): Promise<Bun.Server<undefined>>;
export function createEpisodeServer(options: EpisodeServerOptions & { listen: false }): Promise<EpisodeHandler>;
export async function createEpisodeServer(
  options: EpisodeServerOptions,
): Promise<Bun.Server<undefined> | EpisodeHandler> {
  const episodeRoot = await realpath(resolve(options.episodeDir));
  let analyzing = false;
  let rebuildingArchive = false;
  const analyze: FrameAnalyzer =
    options.analyzeFrame ??
    (async (frame, signal) => {
      const { analyzeFrameRgba } = await import("../../frame-analysis");
      const result = await analyzeFrameRgba(frame, {
        backend: "chromium",
        chromiumExecutable: options.chromiumExecutable ?? Bun.env.BUN_VIDEO_CHROMIUM_EXECUTABLE,
        timeout: 5000,
        signal,
      });
      const compact: FrameMetrics = {
        dominantColor: result.dominantColor,
        samples: result.samples,
        meanLuminance: result.meanLuminance,
        luminanceVariance: result.luminanceVariance,
        laplacianVariance: result.laplacianVariance,
        edgeEnergy: result.edgeEnergy,
        detailScore: result.detailScore,
        lowDetail: result.lowDetail,
        elapsedMs: result.elapsedMs,
        computation: result.computation,
        adapter: result.adapter,
      };
      return compact;
    });
  let script: Blob | undefined;
  let stylesheet: Blob | undefined;
  if (options.bundle !== false) {
    const integrationRoot = resolve(import.meta.dir, "../../../../web/rust/integrations/m3");
    const { m3Bun } = await import(Bun.resolveSync("@aphrody/m3-bun/plugin", integrationRoot));
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "app.tsx")],
      target: "browser",
      minify: true,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [
        {
          name: "episode-react-owner",
          setup(build) {
            build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({
              path: Bun.resolveSync(args.path, import.meta.dir),
            }));
          },
        },
        m3Bun({ configDir: import.meta.dir, svelte: false }),
      ],
    });
    if (!build.success) throw new AggregateError(build.logs, "Compilation de l’atelier épisode impossible");
    script = build.outputs.find(output => output.path.endsWith(".js"));
    stylesheet = build.outputs.find(output => output.path.endsWith(".css"));
  }
  const handle = async (request: Request): Promise<Response> => {
    {
      const url = new URL(request.url);
      if (url.pathname === "/api/frame-analysis") {
        const reply = (value: unknown, status = 200) =>
          Response.json(value, {
            status,
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
          });
        if (request.method !== "POST") return reply({ error: "POST requis" }, 405);
        if (request.headers.get("Origin") && request.headers.get("Origin") !== url.origin)
          return reply({ error: "Origine refusée" }, 403);
        if (request.headers.get("Content-Type") !== "application/octet-stream")
          return reply({ error: "RGBA binaire requis" }, 415);
        const width = Number(url.searchParams.get("width")),
          height = Number(url.searchParams.get("height"));
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 4 ||
          height < 4 ||
          width > 256 ||
          height > 256
        )
          return reply({ error: "Dimensions requises : 4..256 pixels" }, 400);
        if (analyzing) return reply({ error: "Une analyse est déjà en cours" }, 429);
        analyzing = true;
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
        try {
          const size = width * height * 4;
          if (request.headers.has("Content-Length") && Number(request.headers.get("Content-Length")) !== size)
            return reply({ error: "Taille RGBA invalide" }, 400);
          if (!request.body) return reply({ error: "Pixels manquants" }, 400);
          const data = new Uint8Array(size),
            reader = request.body.getReader();
          let offset = 0;
          const abort = () => void reader.cancel().catch(() => {});
          signal.addEventListener("abort", abort, { once: true });
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              if (offset + chunk.value.byteLength > size) {
                await reader.cancel();
                return reply({ error: "Taille RGBA invalide" }, 400);
              }
              data.set(chunk.value, offset);
              offset += chunk.value.byteLength;
            }
          } finally {
            signal.removeEventListener("abort", abort);
            reader.releaseLock();
          }
          if (offset !== size) return reply({ error: "Taille RGBA invalide" }, 400);
          return reply(await analyze({ data, width, height }, signal));
        } catch {
          return reply({ error: "Analyse GPU indisponible ; thème local conservé" }, 503);
        } finally {
          analyzing = false;
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Méthode refusée", { status: 405, headers: { Allow: "GET, HEAD" } });
      const headers = new Headers({
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      const response = (body: BodyInit | null, status = 200) =>
        new Response(request.method === "HEAD" ? null : body, { status, headers });
      if (url.pathname === "/") {
        headers.set("Content-Type", "text/html; charset=utf-8");
        return response(document);
      }
      if (url.pathname === "/app.js" && script) {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
        return response(script);
      }
      if (url.pathname === "/style.css") {
        headers.set("Content-Type", "text/css; charset=utf-8");
        return response(stylesheet ?? Bun.file(resolve(import.meta.dir, "style.css")));
      }
      if (url.pathname !== "/api/manifest" && !url.pathname.startsWith("/media/")) return response("Introuvable", 404);
      const manifestFile = Bun.file(resolve(episodeRoot, "manifest.json"));
      if (!(await manifestFile.exists())) return response("Le manifeste de l’épisode est en cours de création", 503);
      let manifest: EpisodeManifest;
      try {
        manifest = await manifestFile.json();
      } catch {
        return response("Le manifeste de l’épisode est illisible", 503);
      }
      if (url.pathname === "/api/manifest") {
        headers.set("Content-Type", "application/json; charset=utf-8");
        return response(JSON.stringify(manifest));
      }
      let path: string;
      try {
        path = decodeURIComponent(url.pathname.slice("/media/".length));
      } catch {
        return response("Chemin invalide", 400);
      }
      if (!safeRelative(path) || !allowedAsset(manifest, path)) return response("Fichier non autorisé", 404);
      const type =
        path.split("/").at(-1) === "SHA256SUMS"
          ? "text/plain; charset=utf-8"
          : mediaTypes[path.split(".").at(-1)?.toLowerCase() ?? ""];
      if (!type) return response("Format non autorisé", 404);
      let absolute: string;
      try {
        absolute = await realpath(resolve(episodeRoot, path));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        const declared = manifest.package?.volumes.find(item => item.file === path);
        if (request.method !== "GET" || !declared) return response("Fichier absent du disque", 404);
        if (rebuildingArchive) {
          headers.set("Retry-After", "1");
          return response("Une archive est en cours de reconstruction", 429);
        }
        const metadata = manifest.package!.manifest;
        if (!safeRelative(metadata)) return response("Manifeste d’archives invalide", 503);
        rebuildingArchive = true;
        try {
          const metadataPath = resolve(episodeRoot, metadata),
            metadataStat = await lstat(metadataPath);
          if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > 64 * 1024 * 1024)
            return response("Manifeste d’archives indisponible", 503);
          if (!contains(episodeRoot, await realpath(metadataPath))) return response("Manifeste non autorisé", 503);
          const immutable: EpisodePackageManifest = await Bun.file(metadataPath).json();
          const bundle = immutable.bundles.find(item => item.file === path);
          if (!bundle || bundle.bytes !== declared.bytes || bundle.sha256 !== declared.sha256)
            return response("Descripteur d’archive incohérent", 503);
          await (options.rehydrateVolume ?? rehydrateEpisodeVolume)(episodeRoot, immutable, bundle, {
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
            maximumBytes: 128 * 1024 * 1024,
          });
          absolute = await realpath(resolve(episodeRoot, path));
        } catch {
          return response("Reconstruction impossible : sources ou SHA-256 d’origine indisponibles", 503);
        } finally {
          rebuildingArchive = false;
        }
      }
      if (!contains(episodeRoot, absolute)) return response("Fichier non autorisé", 404);
      const file = Bun.file(absolute);
      const size = file.size;
      headers.set("Content-Type", type);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", String(size));
      if (url.searchParams.has("download"))
        headers.set(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1)!)}`,
        );
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        const range = byteRange(rangeHeader, size);
        if (!range) {
          headers.set("Content-Range", `bytes */${size}`);
          headers.delete("Content-Length");
          return response(null, 416);
        }
        headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        headers.set("Content-Length", String(range.end - range.start + 1));
        return response(file.slice(range.start, range.end + 1), 206);
      }
      return response(file);
    }
  };
  if (options.listen === false) return { fetch: handle };
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 3217,
    idleTimeout: 0,
    maxRequestBodySize: 262144,
    fetch: handle,
  });
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun src/apps/episode-studio/server.ts [--episode-dir CHEMIN] [--port 3217|0]");
  } else {
    let episodeDir = resolve(import.meta.dir, "../../../.local/episodes/beerus-01");
    let port = 3217;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag !== "--episode-dir" && flag !== "--port") throw new Error(`Option inconnue : ${flag}`);
      const value = args[++index];
      if (!value) throw new Error(`Valeur manquante : ${flag}`);
      if (flag === "--episode-dir") episodeDir = value;
      else {
        port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Port invalide : ${value}`);
      }
    }
    const server = await createEpisodeServer({ episodeDir, port });
    console.log(`Atelier épisode : ${server.url}`);
  }
}
