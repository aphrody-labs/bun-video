import site from "../src/apps/video-data-site.html";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { VideoCatalog, defaultVideoCatalogPath } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";
import { openConfiguredVideoCatalog } from "./video-neon-runtime";
import { UnifiedVideoPipeline } from "./video-workflow";
import { importCapturedVideoNetwork } from "./video-capture";
import {
  createVideoDatasetCache,
  exportVideoDataset,
  queryVideoDataset,
  type VideoDatasetQuery,
} from "./video-dataset";
import { validateVideoTask, type VideoRenderTask } from "./video-worker-task";
import type { VideoWorkerPoolOptions } from "./video-workers";

export interface VideoDataSiteOptions {
  catalog?: VideoCatalog | NeonVideoCatalog;
  dbPath?: string;
  port?: number;
  /** Set to false to mount the handler in another server; no listener is started. */
  listen?: boolean;
  privateRoot?: string;
  redisURL?: string;
  workers?: number;
  timeoutMs?: number;
  initialize?: boolean;
  runner?: VideoWorkerPoolOptions["runner"];
}

const MAX_BODY = 256 * 1024 * 1024;
const formats = {
  json: { extension: "json", mime: "application/json" },
  jsonl: { extension: "jsonl", mime: "application/x-ndjson" },
  sql: { extension: "sql", mime: "application/sql" },
  wiki: { extension: "md", mime: "text/markdown; charset=utf-8" },
} as const;
const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}
function httpError(status: number): Response {
  const messages: Record<number, string> = {
    400: "Requête invalide.",
    403: "Origine non autorisée.",
    404: "Ressource indisponible.",
    405: "Méthode non autorisée.",
    413: "Fichier trop volumineux.",
    500: "Opération indisponible.",
  };
  return json({ error: messages[status] ?? messages[500] }, status);
}

/** Loopback application; its HTTP surface exposes curated metadata and downloads only. */
export async function createVideoDataSite(options: VideoDataSiteOptions = {}) {
  const privateRoot = resolve(options.privateRoot ?? join(dirname(defaultVideoCatalogPath()), "site"));
  if (options.privateRoot && (!isAbsolute(options.privateRoot) || options.privateRoot.includes("\0")))
    throw new TypeError("Site private root must be absolute");
  const aphrodyHome = dirname(dirname(dirname(defaultVideoCatalogPath())));
  const rawRoot = options.privateRoot ? join(privateRoot, "raw") : join(aphrodyHome, "cookies", "bun-video", "site");
  mkdirSync(privateRoot, { recursive: true });
  mkdirSync(rawRoot, { recursive: true });
  const ownsCatalog = !options.catalog;
  const catalog = options.catalog ?? (await openConfiguredVideoCatalog({ sqlitePath: options.dbPath }));
  const queryCatalog = (query: VideoDatasetQuery) =>
    catalog instanceof NeonVideoCatalog ? queryVideoDataset(catalog, query) : queryVideoDataset(catalog, query);
  let mutationEpoch = 0;
  const pipeline = new UnifiedVideoPipeline({
    catalog,
    workers: options.workers ?? 2,
    timeoutMs: options.timeoutMs ?? 300000,
    workRoot: join(privateRoot, "jobs"),
    runner: options.runner,
    onEvent(event) {
      mutationEpoch++;
      void event;
    },
  });
  const cache = createVideoDatasetCache({ sqlitePath: join(privateRoot, "cache.sqlite"), redisURL: options.redisURL });
  const active = new Set<Promise<unknown>>();
  let closed = false;
  try {
    if (options.initialize !== false) await pipeline.initialize();
    await cache.probe();
    if (catalog instanceof VideoCatalog)
      catalog.db.exec(
        "CREATE TABLE IF NOT EXISTS video_site_exports(id TEXT PRIMARY KEY,format TEXT NOT NULL,path TEXT NOT NULL,createdAt INTEGER NOT NULL,documents INTEGER NOT NULL,records INTEGER NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL)",
      );
  } catch (error) {
    cache.close();
    await pipeline.close();
    if (ownsCatalog) await catalog.close();
    throw error;
  }
  let server: Bun.Server<undefined> | undefined;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return httpError(404);
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") return httpError(405);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) return httpError(403);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return httpError(413);
    try {
      if (url.pathname === "/api/overview") {
        if (request.method !== "GET") return httpError(405);
        const sources = (await queryCatalog({ table: "sources", limit: 1 })).total;
        const entries = (await queryCatalog({ table: "capture_entries", limit: 1 })).total;
        const resources = (await queryCatalog({ table: "captured_resources", limit: 1 })).total;
        const jobs = (await queryCatalog({ table: "jobs", limit: 1 })).total;
        return json({
          sources,
          entries,
          resources,
          jobs,
          cache: await cache.probe(),
          runtime: "Bun",
          playbackQualified: false,
        });
      }
      if (url.pathname === "/api/query") {
        if (request.method !== "POST") return httpError(405);
        if (Number(request.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) return httpError(413);
        const query = (await request.json()) as VideoDatasetQuery;
        // Validate before lookup; a cached entry can never widen the SQL allowlist.
        const result = await queryCatalog(query);
        if (catalog instanceof NeonVideoCatalog) return json(result);
        const version = catalog.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
        const key = JSON.stringify({ query, mutationEpoch, version });
        try {
          const cached = await cache.cache.get<typeof result>(key);
          if (
            cached &&
            cached.table === result.table &&
            cached.total === result.total &&
            JSON.stringify(cached.columns) === JSON.stringify(result.columns)
          )
            return json(cached);
          await cache.cache.set(key, result, 5);
        } catch {
          /* An optional cache does not prevent reading the canonical SQLite. */
        }
        return json(result);
      }
      if (url.pathname === "/api/import") {
        if (request.method !== "POST") return httpError(405);
        if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return httpError(400);
        const form = await request.formData();
        const file = form.get("capture");
        if (!(file instanceof File) || !file.size) return httpError(400);
        if (file.size > MAX_BODY) return httpError(413);
        const id = crypto.randomUUID();
        const input = join(rawRoot, "uploads", `${id}.har`);
        mkdirSync(dirname(input), { recursive: true });
        await Bun.write(input, file);
        const result = await importCapturedVideoNetwork(input, {
          catalog,
          outputDirectory: join(rawRoot, "captures", id),
        });
        mutationEpoch++;
        const { sourcePath: privateSource, captureIndexPath: privateIndex, ...safe } = result;
        void privateSource;
        void privateIndex;
        return json(safe, 201);
      }
      if (url.pathname === "/api/export") {
        if (request.method !== "POST") return httpError(405);
        const input = (await request.json()) as {
          format: keyof typeof formats;
          includeText?: boolean;
          sourceId?: string;
        };
        if (
          !Object.hasOwn(formats, input.format) ||
          (input.includeText !== undefined && typeof input.includeText !== "boolean") ||
          (input.sourceId !== undefined && typeof input.sourceId !== "string")
        )
          return httpError(400);
        const id = crypto.randomUUID();
        const output = join(privateRoot, "exports", `${id}.${formats[input.format].extension}`);
        const exported = await exportVideoDataset(catalog, {
          format: input.format,
          output,
          includeText: input.includeText,
          sourceId: input.sourceId,
        });
        if (catalog instanceof NeonVideoCatalog)
          await catalog.recordSiteExport({
            id,
            format: input.format,
            path: output,
            documents: exported.documents,
            records: exported.records,
            bytes: exported.bytes,
            sha256: exported.sha256,
          });
        else
          catalog.db
            .query("INSERT INTO video_site_exports VALUES(?,?,?,?,?,?,?,?)")
            .run(
              id,
              input.format,
              output,
              Date.now(),
              exported.documents,
              exported.records,
              exported.bytes,
              exported.sha256,
            );
        return json(
          {
            id,
            format: input.format,
            documents: exported.documents,
            records: exported.records,
            bytes: exported.bytes,
            sha256: exported.sha256,
            excludedResources: exported.excludedResources,
          },
          201,
        );
      }
      if (url.pathname.startsWith("/api/exports/")) {
        if (!["GET", "HEAD"].includes(request.method)) return httpError(405);
        const id = url.pathname.slice("/api/exports/".length);
        if (!uuidPattern.test(id)) return httpError(404);
        const record =
          catalog instanceof NeonVideoCatalog
            ? await catalog.getSiteExport(id)
            : catalog.db
                .query<{ format: keyof typeof formats; path: string }, [string]>(
                  "SELECT format,path FROM video_site_exports WHERE id=?",
                )
                .get(id);
        if (!record || !Object.hasOwn(formats, record.format)) return httpError(404);
        const format = record.format as keyof typeof formats;
        const inside = relative(join(privateRoot, "exports"), resolve(record.path));
        if (inside.startsWith("..") || isAbsolute(inside) || !(await Bun.file(record.path).exists()))
          return httpError(404);
        return new Response(request.method === "HEAD" ? null : Bun.file(record.path), {
          headers: {
            "content-type": formats[format].mime,
            "content-disposition": `attachment; filename="dataset-${id}.${formats[format].extension}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (url.pathname === "/api/publish") {
        if (request.method !== "POST") return httpError(405);
        return json(
          await pipeline.publish({ outputDirectory: join(privateRoot, "publications"), includeText: true }),
          201,
        );
      }
      if (url.pathname === "/api/jobs") {
        if (request.method !== "POST") return httpError(405);
        const input = (await request.json()) as { jobs?: VideoRenderTask[] } | VideoRenderTask[];
        const jobs = Array.isArray(input) ? input : input.jobs;
        if (!Array.isArray(jobs) || !jobs.length || jobs.length > 1000) return httpError(400);
        for (const job of jobs) validateVideoTask(job);
        const ids: string[] = [];
        for (const job of jobs) {
          const receipt = pipeline.workers.enqueue(job);
          const tracked = receipt.result
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => active.delete(tracked));
          active.add(tracked);
          await receipt.accepted;
          ids.push(receipt.id);
        }
        mutationEpoch++;
        return json({ accepted: jobs.length, ids }, 202);
      }
      return httpError(404);
    } catch (error) {
      return httpError(
        error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof SyntaxError ||
          (error instanceof Error && error.message.startsWith("Invalid HAR"))
          ? 400
          : 500,
      );
    }
  };
  try {
    server =
      options.listen === false
        ? undefined
        : Bun.serve({
            hostname: "127.0.0.1",
            port: options.port ?? 0,
            maxRequestBodySize: MAX_BODY,
            development: false,
            routes: { "/": site },
            fetch(request) {
              const self = server!;
              if (request.headers.get("host") !== self.url.host || new URL(request.url).host !== self.url.host)
                return httpError(403);
              return handle(request);
            },
            error() {
              return httpError(500);
            },
          });
  } catch (error) {
    cache.close();
    await pipeline.close();
    if (ownsCatalog) await catalog.close();
    throw error;
  }
  const close = async () => {
    if (closed) return;
    closed = true;
    server?.stop(true);
    await pipeline.close();
    await Promise.allSettled(active);
    cache.close();
    if (ownsCatalog) await catalog.close();
  };
  return {
    server,
    handle,
    url: server?.url.href ?? "",
    catalog,
    pipeline,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
