// SPDX-License-Identifier: Apache-2.0
import { realpath, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createCrunchyrollShortcutsHandler } from "./apps/crunchyroll-shortcuts";
import { createCrunchyrollApi, type CrunchyrollApiOptions } from "./crunchyroll-api";
import { createDashLab } from "./apps/dash-live";
import { prepareHlsLab } from "./apps/hls-live";
import { discoverSources, probeSource } from "./web-probe";
import { mapCrunchyrollHar } from "./crunchyroll-har-map";
import { loadCrunchyrollCookies, storeCrunchyrollCookies } from "./crunchyroll-cookies";
import { WEBGPU_PROBE_HTML } from "./webgpu";

export interface VideoWebAppOptions {
  /** Directory that local media paths must stay inside. */
  readonly mediaRoot: string;
  /** Optional versioned output from scripts/build-showcase.ts, served as the public product home. */
  readonly showcaseRoot?: string;
  /** Expose the showcase and explicitly public read routes; all other product surfaces require edge identity. */
  readonly publicMode?: boolean;
  /** Trust Access identity headers only when the network origin accepts traffic exclusively from Cloudflare. */
  readonly trustCloudflareAccessHeaders?: boolean;
  /** Bearer token and upstream client for private Crunchyroll metadata routes. */
  readonly crunchyroll?: CrunchyrollApiOptions;
  /** Public origin used to rewrite lab URLs; defaults to the origin of the first lab request. */
  readonly publicOrigin?: string;
  /** Captured or authorized live DASH source for the mounted lab under /labs/dash/. */
  readonly dashLab?: { readonly inputPath: string; readonly mode?: "capture" | "live" };
  /** Enables the HLS lab, prepared from the protected local inputs when first requested. */
  readonly hlsLab?: boolean;
  /** Name of the cookie bundle stored in the OS credential store (bun.secrets); values never leave the store. */
  readonly hlsCookieSecret?: string;
  /** Mounts the video data site API under /api/ and its client under /site/. */
  readonly dataSite?: { readonly privateRoot?: string; readonly dbPath?: string };
  /** Mounts the episode workbench under /episode/ for this episode directory. */
  readonly episodeStudio?: { readonly episodeDir: string; readonly chromiumExecutable?: string };
  /** Server-owned YouTube Data API key. Search results always play through Google's IFrame player. */
  readonly youtube?: {
    readonly apiKey: string;
    readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    /** Trust cf-connecting-ip only when the origin accepts traffic exclusively from Cloudflare. */
    readonly trustCloudflareIdentity?: boolean;
  };
  /** Override the capability probe for tests or restricted deployments. */
  readonly productCapabilities?: () => Promise<unknown>;
}

export interface VideoWebApp {
  readonly fetch: (request: Request) => Promise<Response>;
}

const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);

function isYouTubeUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return ["youtube.com", "youtu.be", "youtube-nocookie.com"].some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

const labs = [
  { id: "dash", title: "DASH lab", command: "bun bd run ./packages/bun-video/src/apps/dash-live.ts" },
  { id: "hls", title: "HLS lab", command: "bun bd run ./packages/bun-video/src/apps/hls-live.ts" },
  { id: "crunchyroll-shortcuts", title: "Raccourcis Crunchyroll", command: "/pwa/ et /extension/ (intégrés)" },
] as const;

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Resolves a caller-supplied media path, refusing anything outside the configured root. */
export function resolveMediaPath(root: string, input: string | null): string | undefined {
  if (!input || input.length > 1024 || input.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, input);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return undefined;
  return target;
}

async function serveShowcaseAsset(root: string, path: string, method: string): Promise<Response | undefined> {
  if (method !== "GET" && method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(path.slice(1));
  } catch {
    return json({ error: "invalid_showcase_path" }, 400);
  }
  if (!relativePath) relativePath = "index.html";
  if (relativePath.includes("\\") || relativePath.includes("\0")) return json({ error: "invalid_showcase_path" }, 400);
  const parts = relativePath.split("/");
  if (parts.some(part => part === ".." || part === "." || part.startsWith(".")))
    return json({ error: "invalid_showcase_path" }, 400);
  const spaPaths = new Set(["catalog", "watch", "shorts", "studio", "about", "playlist/saved", "series", "tools"]);
  const rootPath = await realpath(root).catch(() => undefined);
  if (!rootPath) return path === "/" ? json({ error: "showcase_unavailable" }, 503) : undefined;
  const candidate = resolve(rootPath, relativePath);
  let target = await realpath(candidate).catch(() => undefined);
  if (!target && spaPaths.has(relativePath.replace(/\/$/, "")))
    target = await realpath(resolve(rootPath, "index.html")).catch(() => undefined);
  if (!target) return undefined;
  const relativeTarget = relative(rootPath, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget))
    return json({ error: "invalid_showcase_path" }, 400);
  const extension = target.slice(target.lastIndexOf(".") + 1).toLowerCase();
  const contentType = SHOWCASE_CONTENT_TYPES[extension] ?? "application/octet-stream";
  return new Response(method === "HEAD" ? null : Bun.file(target), {
    headers: {
      "content-type": contentType,
      "cache-control": extension === "html" || extension === "json" ? "public, max-age=60" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

async function loaded(load: () => Promise<unknown>): Promise<boolean> {
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}

/** Bundles a browser client once, lazily, from its TSX entry. */
const bundles = new Map<string, Promise<string>>();
function clientScript(entry: string): Promise<string> {
  let bundle = bundles.get(entry);
  if (!bundle) {
    bundle = (async () => {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "apps", entry)],
        target: "browser",
        format: "esm",
        minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
      });
      if (!build.success) throw new Error(`${entry} bundle failed`);
      return await build.outputs[0]!.text();
    })();
    bundles.set(entry, bundle);
  }
  return bundle;
}

const shellDocument = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bun Video</title><link rel="stylesheet" href="/app/app.css"></head><body><div id="root"></div><script type="module" src="/app/app.js"></script></body></html>`;

const DATA_API = /^\/api\/(overview|query|import|export|exports\/|publish|jobs)(\/|$)/;

const SHOWCASE_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  srt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  vtt: "text/vtt; charset=utf-8",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff2: "font/woff2",
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:15px system-ui,sans-serif;margin:2rem;max-width:960px;color:#111}code{background:#f2f2f2;padding:.1rem .3rem}li{margin:.4rem 0}</style>
</head><body>${body}</body></html>`;

/** One Bun.serve-compatible app: media, studio, Crunchyroll, shortcuts, labs and composition status. */
export function createVideoWebApp(options: VideoWebAppOptions): VideoWebApp {
  const crunchyroll = createCrunchyrollApi(options.crunchyroll ?? {});
  const shortcuts = createCrunchyrollShortcutsHandler();
  let dashLab: ReturnType<typeof createDashLab> | undefined;
  let hlsLab: ReturnType<typeof prepareHlsLab> | undefined;
  let hls: Awaited<ReturnType<typeof prepareHlsLab>> | undefined;
  let dataSite: Promise<{ handle: (request: Request) => Promise<Response> }> | undefined;
  let pipelineInstance: ReturnType<typeof import("./video-workflow").openConfiguredUnifiedVideoPipeline> | undefined;
  let episode: Promise<{ fetch: (request: Request) => Promise<Response> }> | undefined;
  const youtubeSearchWindow = new Map<string, number[]>();
  let watchRunning = false;

  const unifiedPipeline = () => {
    pipelineInstance ??= import("./video-workflow")
      .then(m => m.openConfiguredUnifiedVideoPipeline())
      .catch(error => {
        pipelineInstance = undefined;
        throw error;
      });
    return pipelineInstance;
  };

  /** Starts a network capture through the owner-configured local CDP endpoint only. */
  const capture = async (request: Request): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as { url?: unknown; endpoint?: unknown } | null;
    const target = typeof body?.url === "string" && URL.canParse(body.url) ? new URL(body.url) : undefined;
    if (!target || !["https:", "http:"].includes(target.protocol)) return json({ error: "invalid_url" }, 400);
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
    if (endpoint !== undefined) {
      const parsed = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
      if (
        !parsed ||
        !["ws:", "http:"].includes(parsed.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      )
        return json({ error: "endpoint_must_be_loopback" }, 400);
    }
    try {
      const pipeline = await unifiedPipeline();
      await pipeline.capture(target.href, endpoint ? { endpoint } : {});
      return json({ status: "capture_finished", url: target.origin });
    } catch {
      return json({ error: "capture_failed" }, 422);
    }
  };

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (options.showcaseRoot && (request.method === "GET" || request.method === "HEAD")) {
      const showcase = await serveShowcaseAsset(options.showcaseRoot, path, request.method);
      if (showcase) return showcase;
    }

    if (options.publicMode) {
      if (path === "/" && !options.showcaseRoot) return json({ error: "showcase_unavailable" }, 503);
      const publicRead =
        (request.method === "GET" || request.method === "HEAD") &&
        ["/api/health", "/api/capabilities", "/api/youtube/search"].includes(path);
      const hasEdgeIdentity =
        options.trustCloudflareAccessHeaders &&
        Boolean(request.headers.get("cf-access-authenticated-user-email")) &&
        Boolean(request.headers.get("cf-access-jwt-assertion"));
      if (!publicRead && !hasEdgeIdentity) return json({ error: "access_required" }, 401);
    }

    if (options.showcaseRoot && (path === "/workbench" || path === "/workbench/"))
      return new Response(shellDocument, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });

    if (hls && path.startsWith(hls.prefix)) return hls.handle(request);

    if (path === "/labs/hls/" || path === "/labs/hls") {
      if (!options.hlsLab) return json({ error: "lab_not_configured" }, 404);
      const secretArgs = options.hlsCookieSecret ? ["--cookie-secret", options.hlsCookieSecret] : [];
      hlsLab ??= prepareHlsLab(["--mounted", ...secretArgs]).catch(() => {
        hlsLab = undefined;
        return undefined;
      });
      const prepared = await hlsLab;
      if (!prepared) return json({ error: "lab_unavailable" }, 503);
      hls = prepared;
      return Response.redirect(new URL(`${prepared.prefix}/`, url.origin), 302);
    }

    if (path.startsWith("/labs/dash/")) {
      if (!options.dashLab) return json({ error: "lab_not_configured" }, 404);
      if (!dashLab) {
        dashLab = createDashLab({
          ...options.dashLab,
          origin: options.publicOrigin ?? url.origin,
          prefix: "/labs/dash/",
        });
        dashLab.catch(() => (dashLab = undefined));
      }
      const lab = await dashLab;
      return lab.fetch(request);
    }

    if (path === "/episode") return Response.redirect(new URL("/episode/", url.origin), 301);

    if (path.startsWith("/episode/") && options.episodeStudio) {
      const handler = await (episode ??= import("./apps/episode-studio/server")
        .then(m => m.createEpisodeServer({ ...options.episodeStudio!, listen: false }))
        .catch(error => {
          episode = undefined;
          throw error;
        }));
      const mounted = new Request(new URL(path.slice("/episode".length) + url.search, url.origin), request);
      return handler.fetch(mounted);
    }

    if (path === "/api/crunchyroll/har-map" && request.method === "POST") {
      const file = url.searchParams.get("file");
      if (!file || !/^[A-Za-z]:[\/]/.test(file)) return json({ error: "absolute_file_required" }, 400);
      try {
        return json(await mapCrunchyrollHar(file));
      } catch (error) {
        return json({ error: "har_invalid", detail: error instanceof Error ? error.message : String(error) }, 422);
      }
    }

    if (path === "/api/crunchyroll/cookies") {
      if (request.method === "PUT") {
        try {
          return json(await storeCrunchyrollCookies(await request.text()));
        } catch (error) {
          return json(
            { error: "cookies_invalid", detail: error instanceof Error ? error.message : String(error) },
            400,
          );
        }
      }
      if (request.method === "GET") {
        const cookies = await loadCrunchyrollCookies();
        return json({ count: cookies?.length ?? 0, present: cookies !== null });
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    if (path.startsWith("/api/crunchyroll")) {
      const forwarded = new URL(request.url);
      forwarded.pathname = path.slice("/api/crunchyroll".length) || "/";
      return crunchyroll(new Request(forwarded, request));
    }

    if (path.startsWith("/pwa/") || path.startsWith("/extension/") || path === "/health") return shortcuts(request);

    if (DATA_API.test(path) && options.dataSite) {
      dataSite ??= import("./video-data-site")
        .then(m => m.createVideoDataSite({ ...options.dataSite, listen: false }))
        .catch(error => {
          dataSite = undefined;
          throw error;
        });
      return (await dataSite).handle(request);
    }

    if (path === "/api/pipeline/capture" && request.method === "POST") return capture(request);

    if (path === "/api/pipeline/run" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        url?: unknown;
        endpoint?: unknown;
        media?: unknown;
        webgpu?: unknown;
      } | null;
      if (!body) return json({ error: "invalid_body" }, 400);
      const media = typeof body.media === "string" ? resolveMediaPath(options.mediaRoot, body.media) : undefined;
      if (typeof body.media === "string" && !media) return json({ error: "invalid_media_path" }, 400);
      const { runPipeline } = await import("./pipeline-run");
      const captureURL = typeof body.url === "string" && URL.canParse(body.url) ? body.url : undefined;
      const endpoint = typeof body.endpoint === "string" ? body.endpoint : undefined;
      const stages = [
        {
          id: "capture",
          enabled: captureURL !== undefined,
          run: async () => {
            const pipeline = await unifiedPipeline();
            await pipeline.capture(captureURL!, endpoint ? { endpoint } : {});
            return captureURL;
          },
        },
        {
          id: "probe",
          enabled: media !== undefined && Bun.Video.available,
          run: async () => {
            await new Bun.Video(media!).metadata();
            return "métadonnées lues";
          },
        },
        {
          id: "frame",
          enabled: media !== undefined && Bun.Video.available,
          run: async () => {
            const bytes = await new Bun.Video(media!).frame(0).resize(640).jpeg({ quality: 85 }).bytes();
            return `${bytes.byteLength} octets`;
          },
        },
        {
          id: "webgpu",
          enabled: body.webgpu === true,
          run: async () => {
            const { probeChromiumWebGpu } = await import("./webgpu");
            const info = await probeChromiumWebGpu({ origin: url.origin, timeout: 15000 });
            return info.available ? "adaptateur disponible" : "indisponible";
          },
        },
        {
          id: "compositions",
          enabled: true,
          run: async () => {
            const [remotion, hyperframes] = await Promise.all([
              loaded(() => import("./render-runtime").then(m => m.loadRemotionCore())),
              loaded(() => import("./render-runtime").then(m => m.loadHyperframesCore())),
            ]);
            if (!remotion || !hyperframes) throw new Error("composition runtime unavailable");
            return "Remotion et HyperFrames chargés";
          },
        },
      ];
      const report = await runPipeline(stages);
      return json(report, report.ok ? 200 : 207);
    }

    const mutatingRoute =
      (path === "/api/crunchyroll/har-map" && request.method === "POST") ||
      (path === "/api/crunchyroll/cookies" && request.method === "PUT");
    if (request.method !== "GET" && request.method !== "HEAD" && !mutatingRoute)
      return json({ error: "method_not_allowed" }, 405);

    if (path === "/api/health")
      return json({
        status: "ok",
        video: { available: Bun.Video.available, decoder: Bun.Video.decoder, backend: Bun.Video.backend },
        labs: labs.map(({ id, title }) => ({ id, title })),
      });

    if (path === "/api/capabilities") {
      const getCapabilities =
        options.productCapabilities ??
        (() =>
          import("./capabilities").then(mod =>
            mod.productCapabilities({ youtubeSearchEnabled: Boolean(options.youtube?.apiKey) }),
          ));
      return json(await getCapabilities());
    }

    if (path === "/api/video/library") {
      const entries = await readdir(resolve(options.mediaRoot), { withFileTypes: true }).catch(() => []);
      const assets = entries
        .filter(
          entry => entry.isFile() && MEDIA_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()),
        )
        .map(entry => ({
          id: entry.name,
          title: entry.name,
          src: `/media/${encodeURIComponent(entry.name)}`,
        }));
      return json({ assets });
    }

    if (path.startsWith("/media/")) {
      const file = resolveMediaPath(options.mediaRoot, decodeURIComponent(path.slice("/media/".length)));
      if (!file) return json({ error: "invalid_media_path" }, 400);
      const blob = Bun.file(file);
      if (!(await blob.exists())) return json({ error: "not_found" }, 404);
      return new Response(request.method === "HEAD" ? null : blob, { headers: { "cache-control": "no-store" } });
    }

    if (path === "/api/video/metadata") {
      const file = resolveMediaPath(options.mediaRoot, url.searchParams.get("src"));
      if (!file) return json({ error: "invalid_media_path" }, 400);
      if (!Bun.Video.available) return json({ error: "video_provider_unavailable" }, 503);
      try {
        return json(await new Bun.Video(file).metadata());
      } catch {
        return json({ error: "media_unreadable" }, 422);
      }
    }

    if (path === "/api/video/frame") {
      const file = resolveMediaPath(options.mediaRoot, url.searchParams.get("src"));
      const seconds = Number(url.searchParams.get("t") ?? "0");
      if (!file) return json({ error: "invalid_media_path" }, 400);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return json({ error: "invalid_time" }, 400);
      if (!Bun.Video.available) return json({ error: "video_provider_unavailable" }, 503);
      try {
        const bytes = await new Bun.Video(file).frame(seconds).resize(640).jpeg({ quality: 85 }).bytes();
        return new Response(Uint8Array.from(bytes), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
        });
      } catch {
        return json({ error: "frame_unavailable" }, 422);
      }
    }

    if (path === "/api/video/watch") {
      const file = resolveMediaPath(options.mediaRoot, url.searchParams.get("src"));
      if (!file) return json({ error: "invalid_media_path" }, 400);
      if (!Bun.Video.available) return json({ error: "video_provider_unavailable" }, 503);
      const detail = url.searchParams.get("detail") ?? "efficient";
      if (!["transcript", "efficient", "balanced"].includes(detail)) return json({ error: "invalid_detail" }, 400);
      const number = (name: string, fallback: number | undefined, min: number, max: number) => {
        const raw = url.searchParams.get(name);
        if (raw === null) return fallback;
        const value = Number(raw);
        return Number.isFinite(value) && value >= min && value <= max ? value : Number.NaN;
      };
      const start = number("start", undefined, 0, 86400);
      const end = number("end", undefined, 0, 86400);
      const frames = number("frames", 12, 1, 24);
      const width = number("width", 320, 64, 480);
      if ([start, end, frames, width].some(value => Number.isNaN(value))) return json({ error: "invalid_range" }, 400);
      if (watchRunning) return json({ error: "watch_busy" }, 429);
      watchRunning = true;
      try {
        const { watch, cleanWatch } = await import("./watch");
        const report = await watch({
          source: file,
          detail: detail as "transcript" | "efficient" | "balanced",
          start,
          end,
          maxFrames: frames,
          resolution: width,
          whisper: "none",
        });
        try {
          const shots = await Promise.all(
            report.frames.map(async frame => ({
              index: frame.index,
              timestampSeconds: frame.timestampSeconds,
              reason: frame.reason,
              dataUrl: `data:image/jpeg;base64,${Buffer.from(await Bun.file(frame.path).arrayBuffer()).toString("base64")}`,
            })),
          );
          const { workDir: _workDir, localMedia: _localMedia, source: _source, frames: _frames, ...summary } = report;
          return json({ ...summary, frames: shots });
        } finally {
          await cleanWatch(report);
        }
      } catch (error) {
        return json({ error: "watch_failed", detail: error instanceof Error ? error.message.slice(0, 200) : "" }, 422);
      } finally {
        watchRunning = false;
      }
    }

    if (path === "/api/video/extract") {
      const source = url.searchParams.get("src");
      if (!source || source.length > 2048) return json({ error: "invalid_source" }, 400);
      const parsed = URL.canParse(source) ? new URL(source) : undefined;
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return json({ error: "invalid_source" }, 400);
      if (isYouTubeUrl(parsed)) return json({ error: "youtube_official_player_required" }, 403);
      try {
        const { extractYtDlp } = await import("./ytdlp");
        return json(await extractYtDlp(parsed.href));
      } catch {
        return json({ error: "extraction_failed" }, 422);
      }
    }

    if (path === "/api/youtube/search") {
      if (!options.youtube?.apiKey) return json({ error: "youtube_search_unavailable" }, 503);
      const query = url.searchParams.get("q")?.trim();
      if (!query || query.length > 160) return json({ error: "invalid_query" }, 400);
      const now = Date.now();
      const client = options.youtube.trustCloudflareIdentity
        ? (request.headers.get("cf-connecting-ip") ?? "unknown")
        : "global";
      const recent = (youtubeSearchWindow.get(client) ?? []).filter(time => now - time < 60_000);
      if (recent.length >= 10) return json({ error: "rate_limited" }, 429);
      if (youtubeSearchWindow.size >= 4096 && !youtubeSearchWindow.has(client)) {
        for (const [key, times] of youtubeSearchWindow)
          if (!times.some(time => now - time < 60_000)) youtubeSearchWindow.delete(key);
        if (youtubeSearchWindow.size >= 4096) return json({ error: "rate_limited" }, 429);
      }
      recent.push(now);
      youtubeSearchWindow.set(client, recent);
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
      endpoint.searchParams.set("part", "snippet");
      endpoint.searchParams.set("type", "video");
      endpoint.searchParams.set("maxResults", "12");
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("key", options.youtube.apiKey);
      try {
        const response = await (options.youtube.fetch ?? fetch)(endpoint, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return json({ error: "youtube_search_failed" }, response.status === 429 ? 503 : 502);
        const body = (await response.json()) as { items?: unknown };
        if (!Array.isArray(body.items)) return json({ error: "youtube_response_invalid" }, 502);
        const items = body.items.slice(0, 12).flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const item = value as { id?: { videoId?: unknown }; snippet?: Record<string, unknown> };
          const id = item.id?.videoId;
          const snippet = item.snippet;
          if (
            typeof id !== "string" ||
            !/^[A-Za-z0-9_-]{11}$/.test(id) ||
            !snippet ||
            typeof snippet.title !== "string"
          )
            return [];
          const thumbnails = snippet.thumbnails as { medium?: { url?: unknown }; high?: { url?: unknown } } | undefined;
          const thumbnail = thumbnails?.high?.url ?? thumbnails?.medium?.url;
          return [
            {
              id,
              title: snippet.title.slice(0, 300),
              description: typeof snippet.description === "string" ? snippet.description.slice(0, 1200) : "",
              channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle.slice(0, 160) : "",
              publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : "",
              ...(typeof thumbnail === "string" && /^https:\/\/([a-z0-9-]+\.)?ytimg\.com\//.test(thumbnail)
                ? { thumbnail }
                : {}),
              provider: "YouTube" as const,
              player: `https://www.youtube-nocookie.com/embed/${id}`,
              source: `https://www.youtube.com/watch?v=${id}`,
            },
          ];
        });
        return json({ provider: "YouTube", items });
      } catch {
        return json({ error: "youtube_search_unavailable" }, 503);
      }
    }

    if (path === "/webgpu")
      return new Response(WEBGPU_PROBE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });

    if (path === "/api/webgpu/probe") {
      try {
        const { probeChromiumWebGpu } = await import("./webgpu");
        return json(await probeChromiumWebGpu({ origin: url.origin, timeout: 15000 }));
      } catch {
        return json({ error: "webgpu_probe_failed" }, 503);
      }
    }

    if (path === "/api/discover") {
      const seeds = url.searchParams.getAll("seed");
      if (!seeds.length) return json({ error: "missing_seed" }, 400);
      try {
        return json(await discoverSources(seeds, { maxPages: 25, maxDepth: 1 }));
      } catch (error) {
        return json({ error: "discovery_failed", detail: error instanceof Error ? error.message : String(error) }, 422);
      }
    }

    if (path === "/api/probe") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "missing_url" }, 400);
      try {
        return json(await probeSource(target));
      } catch (error) {
        return json({ error: "invalid_url", detail: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (path === "/api/pipeline/status") {
      const pipeline = await unifiedPipeline();
      return json({ families: pipeline.apis() });
    }

    if (path === "/api/compositions") {
      const [remotion, hyperframes] = await Promise.all([
        loaded(() => import("./render-runtime").then(m => m.loadRemotionCore())),
        loaded(() => import("./render-runtime").then(m => m.loadHyperframesCore())),
      ]);
      return json({ remotion: { loaded: remotion }, hyperframes: { loaded: hyperframes } });
    }

    if (path === "/site/" || path === "/site")
      return new Response(
        page("Données vidéo", `<div id="root"></div><script type="module" src="/site/app.js"></script>`),
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      );

    if (path === "/site/app.js") {
      try {
        return new Response(await clientScript("video-data-site-client.tsx"), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      } catch {
        return json({ error: "site_unavailable" }, 500);
      }
    }

    if (path === "/studio/app.js") {
      try {
        return new Response(await clientScript("web-studio.tsx"), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      } catch {
        return json({ error: "studio_unavailable" }, 500);
      }
    }

    if (path === "/studio/" || path === "/studio")
      return new Response(
        page("Studio vidéo", `<div id="root"></div><script type="module" src="/studio/app.js"></script>`),
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
      );

    if (path === "/app/app.js") {
      try {
        return new Response(await clientScript("web-app.tsx"), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      } catch {
        return json({ error: "app_unavailable" }, 500);
      }
    }

    if (path === "/app/app.css")
      return new Response(Bun.file(resolve(import.meta.dir, "apps/web-app.css")), {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
      });

    if (path === "/")
      return new Response(shellDocument, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });

    return json({ error: "not_found" }, 404);
  };

  return { fetch: routes };
}
