import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { VideoCatalog } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";
import { CrawlerCache } from "./cache";

export const columnsByTable = {
  sources: ["id", "providerId", "kind"],
  providers: ["id", "name", "family", "status"],
  capabilities: ["id", "family", "exportName", "status"],
  jobs: ["id", "sourceId", "engine", "status", "createdAt", "updatedAt"],
  qualifications: ["id", "sourceId", "providerId", "capabilityId", "status", "createdAt"],
  capture_entries: [
    "id",
    "sourceId",
    "entryIndex",
    "method",
    "host",
    "mimeType",
    "status",
    "encodedBytes",
    "bytes",
    "manifestKind",
    "encrypted",
    "complete",
  ],
  captured_resources: ["id", "sourceId", "entryIndex", "kind", "bytes"],
} as const;
export type VideoDatasetTable = keyof typeof columnsByTable;
export interface VideoDatasetQuery {
  table: VideoDatasetTable;
  columns?: readonly string[];
  where?: Readonly<Record<string, string | number | boolean | null>>;
  limit?: number;
  offset?: number;
}
export interface VideoDatasetQueryResult {
  table: VideoDatasetTable;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}
export interface CuratedVideoDocument {
  id: string;
  sourceId: string;
  entryIndex: number;
  kind: string;
  mimeType: string;
  domain: string;
  path: string;
  title: string;
  headings: string[];
  paragraphs: string[];
  links: { domain: string; path: string }[];
  text: string;
  sha256: string;
  generatedAt: string;
}
export interface VideoDatasetExportResult {
  output: string;
  format: "json" | "jsonl" | "sql" | "wiki";
  documents: number;
  records: number;
  bytes: number;
  sha256: string;
  excludedResources: number;
}

const tableExists = (catalog: VideoCatalog, table: string) =>
  !!catalog.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
/** Public metadata SELECT only. Values use bindings; table and column identifiers are a closed allowlist. */
export function prepareVideoDatasetQuery(request: VideoDatasetQuery) {
  if (!Object.hasOwn(columnsByTable, request.table)) throw new TypeError("Unknown dataset table");
  const allowed: readonly string[] = columnsByTable[request.table];
  const columns = [...(request.columns ?? allowed)];
  if (!columns.length || columns.some(column => !allowed.includes(column)) || new Set(columns).size !== columns.length)
    throw new TypeError("Unknown or private dataset column");
  const limit = request.limit ?? 100;
  const offset = request.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw new RangeError("Dataset pagination exceeds its limits");
  const filters = Object.entries(request.where ?? {});
  const values: (string | number | null)[] = [];
  const conditions = filters.map(([column, value]) => {
    if (!allowed.includes(column)) throw new TypeError("Unknown or private dataset filter");
    if (value === null) return `"${column}" IS NULL`;
    if (
      !(typeof value === "string" || typeof value === "number" || typeof value === "boolean") ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 4096)
    )
      throw new TypeError("Invalid dataset filter value");
    values.push(typeof value === "boolean" ? Number(value) : value);
    return `"${column}" = ?`;
  });
  return { table: request.table, columns, values, conditions, limit, offset };
}

export function queryVideoDataset(catalog: VideoCatalog, request: VideoDatasetQuery): VideoDatasetQueryResult;
export function queryVideoDataset(
  catalog: NeonVideoCatalog,
  request: VideoDatasetQuery,
): Promise<VideoDatasetQueryResult>;
export function queryVideoDataset(
  catalog: VideoCatalog | NeonVideoCatalog,
  request: VideoDatasetQuery,
): VideoDatasetQueryResult | Promise<VideoDatasetQueryResult> {
  const { table, columns, values, conditions, limit, offset } = prepareVideoDatasetQuery(request);
  if (catalog instanceof NeonVideoCatalog)
    return catalog.selectPublicDataset({ table, columns, values, conditions, limit, offset });
  const result: VideoDatasetQueryResult = { table, columns, rows: [], total: 0, limit, offset };
  if (!tableExists(catalog, request.table)) return result;
  const clause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  result.total = catalog.db
    .query<{ total: number }, (string | number | null)[]>(`SELECT COUNT(*) AS total FROM "${request.table}"${clause}`)
    .get(...values)!.total;
  result.rows = catalog.db
    .query<Record<string, unknown>, (string | number | null)[]>(
      `SELECT ${columns.map(column => `"${column}"`).join(",")} FROM "${request.table}"${clause} ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset);
  return result;
}

export function redactVideoDatasetText(value: string): string {
  return value
    .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}(?=$|[^\w-])/g, "[redacted token]")
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, "[redacted cookie]")
    .replace(
      /\b(?:access_token|refresh_token|id_token|session_token|authorization|api[_-]?key|password|secret|token)\s*[=:]\s*["']?[^\s"'<>;,]+/gi,
      "[redacted credential]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/https?:\/\/[^\s<>"']+/gi, text => {
      try {
        const url = new URL(text);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted URL]";
      }
    })
    .trim();
}

const excludedUrl =
  /(?:^|\/)(?:auth|oauth|login|logout|signin|signup|accounts?|profiles?|sessions?|licenses?|telemetry|analytics|tracking|beacon|metrics)(?:[/._-]|$)/i;
function safeLocation(value: string): { domain: string; path: string } | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      excludedUrl.test(url.pathname) ||
      /^(?:auth|account|sso|login|telemetry|analytics)[.-]/i.test(url.hostname)
    )
      return null;
    return { domain: url.hostname, path: redactVideoDatasetText(url.pathname).slice(0, 1024) };
  } catch {
    return null;
  }
}

async function extractArticle(
  html: string,
  url: string,
): Promise<Pick<CuratedVideoDocument, "title" | "headings" | "paragraphs" | "links" | "text">> {
  const items: { kind: string; value: string }[] = [];
  const links: { domain: string; path: string }[] = [];
  let blocked = 0;
  let current: { kind: string; value: string } | undefined;
  const rewriter = new HTMLRewriter()
    .on(
      'script,style,form,nav,header,footer,iframe,object,embed,noscript,template,svg,canvas,[hidden],[aria-hidden="true"],[data-private]',
      {
        element(element) {
          if (
            [
              "area",
              "base",
              "br",
              "col",
              "embed",
              "hr",
              "img",
              "input",
              "link",
              "meta",
              "param",
              "source",
              "track",
              "wbr",
            ].includes(element.tagName)
          )
            return;
          blocked++;
          element.onEndTag(() => {
            blocked--;
          });
        },
      },
    )
    .on("title,h1,h2,h3,h4,h5,h6,p,li,figcaption", {
      element(element) {
        const previous = current;
        const item = { kind: element.tagName, value: "" };
        if (!blocked && items.length < 300) {
          items.push(item);
          current = item;
        }
        element.onEndTag(() => {
          current = previous;
        });
      },
    })
    .on("a[href]", {
      element(element) {
        if (blocked || links.length >= 100) return;
        const href = element.getAttribute("href");
        if (!href) return;
        try {
          const location = safeLocation(new URL(href, url).href);
          if (location && !links.some(link => link.domain === location.domain && link.path === location.path))
            links.push(location);
        } catch {
          /* Invalid and non-HTTP links stay outside the corpus. */
        }
      },
    })
    .onDocument({
      text(chunk) {
        if (!blocked && current && current.value.length < 4096)
          current.value += chunk.text.slice(0, 4096 - current.value.length);
      },
    });
  await rewriter.transform(new Response(html)).text();
  const clean = items
    .map(item => ({ ...item, value: redactVideoDatasetText(item.value.replace(/\s+/g, " ")).slice(0, 4096) }))
    .filter(item => item.value);
  const title = clean.find(item => item.kind === "title")?.value ?? clean.find(item => item.kind === "h1")?.value ?? "";
  const headings = clean.filter(item => /^h[1-6]$/.test(item.kind)).map(item => item.value);
  const paragraphs = clean.filter(item => !/^h[1-6]$/.test(item.kind) && item.kind !== "title").map(item => item.value);
  return {
    title,
    headings,
    paragraphs,
    links,
    text: [title, ...headings, ...paragraphs].filter(Boolean).join("\n\n").slice(0, 40000),
  };
}

async function documentsForCatalog(
  catalog: VideoCatalog | NeonVideoCatalog,
  includeText: boolean,
  sourceId?: string,
): Promise<{ documents: CuratedVideoDocument[]; excludedResources: number }> {
  if (!includeText || (catalog instanceof VideoCatalog && !tableExists(catalog, "captured_resources")))
    return { documents: [], excludedResources: 0 };
  const resources =
    catalog instanceof NeonVideoCatalog
      ? await catalog.listDocumentResources(sourceId)
      : catalog.db
          .query<
            { sourceId: string; entryIndex: number; kind: string; bodyRef: string; bytes: number; privateRef: string },
            [string | null, string | null]
          >(
            `SELECT r.sourceId,r.entryIndex,r.kind,r.bodyRef,r.bytes,s.privateRef FROM captured_resources r JOIN sources s ON s.id=r.sourceId WHERE (? IS NULL OR r.sourceId=?) ORDER BY r.sourceId,r.entryIndex`,
          )
          .all(sourceId ?? null, sourceId ?? null);
  const indexCache = new Map<
    string,
    {
      requests?: {
        entryIndex: number;
        request: { url: string; method: string };
        response: { status: number; mimeType: string };
        encrypted?: boolean;
        complete?: boolean;
      }[];
    }
  >();
  const documents: CuratedVideoDocument[] = [];
  let excludedResources = 0;
  for (const resource of resources) {
    if (!["html", "caption"].includes(resource.kind) || resource.bytes > 2 * 1024 * 1024) {
      excludedResources++;
      continue;
    }
    const root = dirname(resource.privateRef);
    const inside = relative(root, resolve(resource.bodyRef));
    if (inside.startsWith("..") || isAbsolute(inside)) {
      excludedResources++;
      continue;
    }
    let index = indexCache.get(resource.sourceId);
    if (!index) {
      index = await Bun.file(resource.privateRef).json();
      indexCache.set(resource.sourceId, index!);
    }
    const request = index!.requests?.find(row => row.entryIndex === resource.entryIndex);
    const location = request ? safeLocation(request.request.url) : null;
    if (
      !request ||
      !location ||
      request.request.method !== "GET" ||
      request.response.status !== 200 ||
      request.encrypted ||
      request.complete === false
    ) {
      excludedResources++;
      continue;
    }
    const content = await Bun.file(resource.bodyRef).text();
    let extracted: Pick<CuratedVideoDocument, "title" | "headings" | "paragraphs" | "links" | "text">;
    if (resource.kind === "html") extracted = await extractArticle(content, request.request.url);
    else {
      const text = redactVideoDatasetText(
        content
          .split(/\r?\n/)
          .filter(line => line && !/^WEBVTT|^NOTE\b|^\d+$|-->/.test(line))
          .join("\n")
          .replace(/<[^>]*>/g, ""),
      ).slice(0, 40000);
      extracted = { title: "Captured captions", headings: [], paragraphs: text ? [text] : [], links: [], text };
    }
    if (!extracted.text) {
      excludedResources++;
      continue;
    }
    documents.push({
      id: `${resource.sourceId}:${resource.entryIndex}`,
      sourceId: resource.sourceId,
      entryIndex: resource.entryIndex,
      kind: resource.kind,
      mimeType: request.response.mimeType,
      ...location,
      ...extracted,
      sha256: new Bun.CryptoHasher("sha256").update(extracted.text).digest("hex"),
      generatedAt: new Date().toISOString(),
    });
  }
  return { documents, excludedResources };
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export async function exportVideoDataset(
  catalog: VideoCatalog | NeonVideoCatalog,
  options: { format: "json" | "jsonl" | "sql" | "wiki"; output: string; includeText?: boolean; sourceId?: string },
): Promise<VideoDatasetExportResult> {
  if (
    !["json", "jsonl", "sql", "wiki"].includes(options.format) ||
    !isAbsolute(options.output) ||
    options.output.includes("\0")
  )
    throw new TypeError("Dataset output format/path is invalid");
  if (await Bun.file(options.output).exists()) throw new Error("Dataset output already exists");
  const tables: Partial<Record<VideoDatasetTable, Record<string, unknown>[]>> = {};
  let records = 0;
  for (const table of Object.keys(columnsByTable) as VideoDatasetTable[]) {
    const rows: Record<string, unknown>[] = [];
    const where: VideoDatasetQuery["where"] =
      options.sourceId && (columnsByTable[table] as readonly string[]).includes("sourceId")
        ? { sourceId: options.sourceId }
        : options.sourceId && table === "sources"
          ? { id: options.sourceId }
          : undefined;
    for (let offset = 0; offset <= 1000000; offset += 1000) {
      const page =
        catalog instanceof NeonVideoCatalog
          ? await queryVideoDataset(catalog, { table, where, limit: 1000, offset })
          : queryVideoDataset(catalog, { table, where, limit: 1000, offset });
      if (page.total > 1000000) throw new RangeError("Dataset export exceeds the one-million-record limit");
      rows.push(...page.rows);
      if (rows.length >= page.total || !page.rows.length) break;
    }
    tables[table] = rows;
    records += rows.length;
  }
  const { documents, excludedResources } = await documentsForCatalog(
    catalog,
    options.includeText === true,
    options.sourceId,
  );
  let content: string;
  if (options.format === "json")
    content =
      JSON.stringify(
        { format: "bun-video-dataset-v1", generatedAt: new Date().toISOString(), tables, documents, excludedResources },
        null,
        2,
      ) + "\n";
  else if (options.format === "jsonl")
    content =
      [
        ...Object.entries(tables).flatMap(([table, rows]) =>
          rows!.map(row => JSON.stringify({ type: "metadata", table, row })),
        ),
        ...documents.map(document => JSON.stringify({ type: "document", document })),
      ].join("\n") + "\n";
  else if (options.format === "wiki")
    content = [
      "# Curated video capture dataset",
      "",
      ...documents.flatMap(document => [
        `## ${document.title.replace(/[\r\n#]/g, " ") || document.id}`,
        `Source: https://${document.domain}${document.path}`,
        `Provenance: ${document.sourceId} / ${document.entryIndex} / ${document.sha256}`,
        "",
        document.text,
        "",
      ]),
    ].join("\n");
  else
    content = [
      "BEGIN TRANSACTION;",
      "CREATE TABLE IF NOT EXISTS curated_dataset_metadata(tableName TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tableName,id));",
      "CREATE TABLE IF NOT EXISTS curated_dataset_document(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL,entryIndex INTEGER NOT NULL,kind TEXT NOT NULL,mimeType TEXT NOT NULL,domain TEXT NOT NULL,path TEXT NOT NULL,text TEXT NOT NULL,sha256 TEXT NOT NULL,generatedAt TEXT NOT NULL);",
      ...Object.entries(tables).flatMap(([table, rows]) =>
        rows!.map(
          row =>
            `INSERT OR REPLACE INTO curated_dataset_metadata VALUES(${sqlLiteral(table)},${sqlLiteral(String(row.id))},${sqlLiteral(JSON.stringify(row))});`,
        ),
      ),
      ...documents.map(
        document =>
          `INSERT OR REPLACE INTO curated_dataset_document VALUES(${sqlLiteral(document.id)},${sqlLiteral(document.sourceId)},${document.entryIndex},${sqlLiteral(document.kind)},${sqlLiteral(document.mimeType)},${sqlLiteral(document.domain)},${sqlLiteral(document.path)},${sqlLiteral(document.text)},${sqlLiteral(document.sha256)},${sqlLiteral(document.generatedAt)});`,
      ),
      "COMMIT;",
      "",
    ].join("\n");
  mkdirSync(dirname(options.output), { recursive: true });
  await Bun.write(options.output, content);
  return {
    output: options.output,
    format: options.format,
    documents: documents.length,
    records,
    bytes: Bun.file(options.output).size,
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    excludedResources,
  };
}

export function createVideoDatasetCache(options: { sqlitePath: string; redisURL?: string }) {
  if (options.sqlitePath !== ":memory:" && !isAbsolute(options.sqlitePath))
    throw new TypeError("Dataset cache path must be absolute");
  if (options.sqlitePath !== ":memory:") mkdirSync(dirname(options.sqlitePath), { recursive: true });
  const redis = options.redisURL
    ? new Bun.RedisClient(options.redisURL, {
        maxRetries: 1,
        connectionTimeout: 2000,
        autoReconnect: false,
        enableOfflineQueue: false,
      })
    : undefined;
  let redisReady = false;
  async function deadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            redisReady = false;
            redis?.close();
            reject(new Error("Redis dataset cache timed out"));
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const adapter = redis
    ? {
        get: async (key: string) => (redisReady ? deadline(redis.get(key)) : null),
        set: async (key: string, value: string, ...args: unknown[]) =>
          redisReady ? deadline(redis.send("SET", [key, value, ...args.map(String)])) : null,
        del: async (key: string) => (redisReady ? deadline(redis.del(key)) : 0),
      }
    : undefined;
  const storage = new CrawlerCache({
    sqlitePath: options.sqlitePath,
    redis: adapter,
    namespace: "bun-video:curated-dataset",
  });
  const keyHash = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");
  function sanitized(value: unknown, depth = 0): unknown {
    if (depth > 16) throw new RangeError("Dataset cache nesting exceeds its limit");
    if (typeof value === "string") return redactVideoDatasetText(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      if (value.length > 1000) throw new RangeError("Dataset cache array exceeds its limit");
      return value.map(item => sanitized(item, depth + 1));
    }
    if (typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (
            /(?:cookie|header|secret|token|password|authorization|privateRef|bodyRef|evidenceRef|config|session|conversation|messages)|^(?:request|response|body|raw|html|javascript|css|constructor|prototype|__proto__)$/i.test(
              key,
            )
          )
            throw new TypeError("Private values are excluded from the dataset cache");
          return [key, sanitized(item, depth + 1)];
        }),
      );
    throw new TypeError("Unsupported dataset cache value");
  }
  const cache = {
    async get<T>(key: string): Promise<T | null> {
      return storage.get<T>(keyHash(key));
    },
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const clean = sanitized(value);
      if (JSON.stringify(clean).length > 2 * 1024 * 1024) throw new RangeError("Dataset cache value exceeds 2 MiB");
      await storage.set(keyHash(key), clean, ttlSeconds);
    },
    async delete(key: string): Promise<void> {
      await storage.delete(keyHash(key));
    },
  };
  return {
    cache,
    async probe(): Promise<{ sqlite: "ready"; redis: "disabled" | "connected" | "failed" }> {
      if (!redis) return { sqlite: "ready", redis: "disabled" };
      try {
        redisReady = await deadline(
          (async () => {
            await redis.connect();
            return (await redis.ping()) === "PONG";
          })(),
        );
        return { sqlite: "ready", redis: redisReady ? "connected" : "failed" };
      } catch {
        redisReady = false;
        redis.close();
        return { sqlite: "ready", redis: "failed" };
      }
    },
    close() {
      redis?.close();
      storage.close();
    },
    [Symbol.dispose]() {
      redis?.close();
      storage.close();
    },
  };
}
