import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CapturedHar } from "./har";
import { inspectDashManifest } from "./dash";
import type { VideoCatalog } from "./video-catalog";
import type { NeonVideoCatalog } from "./video-neon-catalog";

interface HarHeader {
  name: string;
  value: string;
}
interface HarCaptureEntry {
  request: { url: string; method: string; headers?: HarHeader[]; [key: string]: unknown };
  response: {
    status: number;
    headers?: HarHeader[];
    content: { mimeType: string; text?: string; encoding?: string; size?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  pageref?: string;
  [key: string]: unknown;
}
export type CapturedAssetKind =
  | "html"
  | "script"
  | "style"
  | "json"
  | "image"
  | "poster"
  | "font"
  | "media"
  | "manifest"
  | "caption"
  | "license"
  | "other";
export interface CapturedVideoNetworkSummary {
  sourceId: string;
  sourcePath: string;
  captureIndexPath: string;
  entries: number;
  pages: number;
  bodyCount: number;
  bodyBytes: number;
  mediaCount: number;
  manifestCount: number;
  encryptedManifestCount: number;
  encryptedMediaCount: number;
  incompleteMediaCount: number;
  clearCompleteMediaCount: number;
  invalidManifestCount: number;
  assetCounts: Record<CapturedAssetKind, number>;
  playbackValidated: false;
}
export interface NormalizedCapturedRequest {
  requestId: string;
  entryIndex: number;
  request: { url: string; method: string; headers: Record<string, string>; [key: string]: unknown };
  response: { status: number; mimeType: string; headers: Record<string, string>; [key: string]: unknown };
  bodyFile?: string;
  bytes: number;
  encodedBytes: number;
  kind: CapturedAssetKind;
  manifestKind: "dash" | "hls" | null;
  encrypted: boolean;
  encryptionEvidence: string[];
  complete: boolean;
  renderable: boolean;
  range: { requested: string | null; received: string | null };
  har: Record<string, unknown>;
}

const defaultCaptureRoot = () =>
  join(
    Bun.env.APHRODY_HOME ??
      join(
        Bun.env.USERPROFILE ??
          Bun.env.HOME ??
          (() => {
            throw new Error("A protected capture directory is required");
          })(),
        ".aphrody",
      ),
    "cookies",
    "bun-video",
    "captures",
  );
const headersObject = (headers: HarHeader[] = []) => {
  const result: Record<string, string> = Object.create(null);
  for (const header of headers) {
    const key = header.name.toLowerCase();
    result[key] = result[key] === undefined ? header.value : `${result[key]}\n${header.value}`;
  }
  return result;
};
function normalizedMime(value: string): string {
  const mime = value.split(";")[0]!.trim().toLowerCase();
  return /^[a-z\d.+-]+\/[a-z\d.+-]+$/.test(mime) ? mime : "application/octet-stream";
}
function kindFor(
  entry: HarCaptureEntry,
  mime: string,
): { kind: CapturedAssetKind; manifestKind: "dash" | "hls" | null; extension: string } {
  const url = new URL(entry.request.url);
  const path = url.pathname.toLowerCase();
  if (
    /licen[cs]e|widevine|playready/.test(url.hostname + path) &&
    (entry.request.method !== "GET" || !/text\/html/.test(mime))
  )
    return { kind: "license", manifestKind: null, extension: "bin" };
  if (mime === "application/dash+xml" || path.endsWith(".mpd"))
    return { kind: "manifest", manifestKind: "dash", extension: "mpd" };
  if (/mpegurl/.test(mime) || path.endsWith(".m3u8"))
    return { kind: "manifest", manifestKind: "hls", extension: "m3u8" };
  if (
    /^(video|audio)\//.test(mime) ||
    (mime === "application/octet-stream" && /\.(mp4|m4[asv]|webm|ts|aac|mp3|ogg)$/.test(path))
  )
    return {
      kind: "media",
      manifestKind: null,
      extension: /webm/.test(mime)
        ? "webm"
        : path.endsWith(".m4s")
          ? "m4s"
          : path.endsWith(".ts")
            ? "ts"
            : /audio\//.test(mime)
              ? "audio"
              : "mp4",
    };
  if (/vtt|ttml|subrip/.test(mime) || /\.(vtt|srt|ass|ttml)$/.test(path))
    return {
      kind: "caption",
      manifestKind: null,
      extension: /vtt/.test(mime + path) ? "vtt" : /ttml/.test(mime + path) ? "ttml" : "srt",
    };
  if (/html/.test(mime) || /\.html?$/.test(path)) return { kind: "html", manifestKind: null, extension: "html" };
  if (/javascript|ecmascript/.test(mime) || /\.(?:m?js|cjs)$/.test(path))
    return { kind: "script", manifestKind: null, extension: "js" };
  if (mime === "text/css" || path.endsWith(".css")) return { kind: "style", manifestKind: null, extension: "css" };
  if (/json/.test(mime) || path.endsWith(".json")) return { kind: "json", manifestKind: null, extension: "json" };
  if (mime.startsWith("image/"))
    return {
      kind: /poster|thumbnail|thumb/.test(path) ? "poster" : "image",
      manifestKind: null,
      extension:
        (
          {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/svg+xml": "svg",
            "image/webp": "webp",
            "image/gif": "gif",
            "image/avif": "avif",
          } as Record<string, string>
        )[mime] ?? "image",
    };
  if (/font|woff|opentype/.test(mime) || /\.(?:woff2?|ttf|otf)$/.test(path))
    return {
      kind: "font",
      manifestKind: null,
      extension: /woff2/.test(mime + path)
        ? "woff2"
        : /woff/.test(mime + path)
          ? "woff"
          : path.endsWith(".ttf")
            ? "ttf"
            : path.endsWith(".otf")
              ? "otf"
              : "font",
    };
  return { kind: "other", manifestKind: null, extension: "body" };
}

/** Extract all recorded response bodies; raw HAR stays at its original path. No site is contacted. */
export async function importCapturedVideoNetwork(
  inputPath: string,
  options: { catalog?: VideoCatalog | NeonVideoCatalog; outputDirectory?: string } = {},
): Promise<CapturedVideoNetworkSummary> {
  if (!isAbsolute(inputPath) || inputPath.includes("\0"))
    throw new TypeError("HAR input must be an absolute path without NUL");
  const sourcePath = resolve(inputPath);
  const input = Bun.file(sourcePath);
  if (!(await input.exists())) throw new Error("HAR input is missing");
  if (input.size > 256 * 1024 * 1024) throw new RangeError("HAR exceeds the 256 MiB per-capture limit");
  const parsed = (await input.json()) as {
    log: { entries: HarCaptureEntry[]; pages?: unknown[]; [key: string]: unknown };
  };
  const captured = new CapturedHar(parsed);
  const sourceId = crypto.randomUUID();
  const directory = resolve(options.outputDirectory ?? join(defaultCaptureRoot(), sourceId));
  if (await Bun.file(join(directory, "capture-index.json")).exists())
    throw new Error("Capture output already exists; choose a fresh directory");
  mkdirSync(join(directory, "bodies"), { recursive: true });
  const manifestInfo = new Map<number, { encrypted: boolean; metadata: unknown }>();
  const encryptedPrefixes: { origin: string; path: string }[] = [];
  let invalidManifestCount = 0;
  for (const [index, entry] of parsed.log.entries.entries()) {
    const mime = normalizedMime(entry.response.content.mimeType);
    const kind = kindFor(entry, mime);
    if (!kind.manifestKind || !entry.response.content.text) continue;
    const bytes = Buffer.from(
      entry.response.content.text,
      entry.response.content.encoding === "base64" ? "base64" : "utf8",
    );
    const text = new TextDecoder().decode(bytes);
    try {
      const metadata =
        kind.manifestKind === "dash"
          ? inspectDashManifest(text)
          : captured.summary.manifests.find(item => item.entryIndex === index)?.metadata;
      if (!metadata) throw new Error("Invalid captured manifest");
      manifestInfo.set(index, { encrypted: metadata.encrypted, metadata });
      if (metadata.encrypted) {
        const url = new URL(entry.request.url);
        const path = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
        if (path.split("/").filter(Boolean).length >= 2) encryptedPrefixes.push({ origin: url.origin, path });
        if (kind.manifestKind === "dash") {
          for (const match of text.matchAll(
            /(?:\b(?:media|initialization)=["']([^"']+)["']|<(?:(?:\w+):)?BaseURL\b[^>]*>([^<]+)<\/(?:(?:\w+):)?BaseURL>)/g,
          )) {
            const reference = (match[1] ?? match[2] ?? "").trim().replaceAll("&amp;", "&");
            try {
              const media = new URL(reference.split("$")[0]!, url);
              if (media.pathname.split("/").filter(Boolean).length >= 2)
                encryptedPrefixes.push({
                  origin: media.origin,
                  path: reference.includes("$")
                    ? media.pathname
                    : media.pathname.slice(0, media.pathname.lastIndexOf("/") + 1),
                });
            } catch {
              /* Invalid references do not establish encryption linkage. */
            }
          }
        }
      }
    } catch {
      invalidManifestCount++;
    }
  }
  const requests: NormalizedCapturedRequest[] = [];
  const assetCounts: Record<CapturedAssetKind, number> = {
    html: 0,
    script: 0,
    style: 0,
    json: 0,
    image: 0,
    poster: 0,
    font: 0,
    media: 0,
    manifest: 0,
    caption: 0,
    license: 0,
    other: 0,
  };
  let bodyCount = 0,
    bodyBytes = 0,
    mediaCount = 0,
    manifestCount = 0,
    encryptedManifestCount = 0,
    encryptedMediaCount = 0,
    incompleteMediaCount = 0,
    clearCompleteMediaCount = 0;
  for (const [index, entry] of parsed.log.entries.entries()) {
    const mime = normalizedMime(entry.response.content.mimeType);
    const classification = kindFor(entry, mime);
    const url = new URL(entry.request.url);
    const requestHeaders = headersObject(entry.request.headers);
    const responseHeaders = headersObject(entry.response.headers);
    const text = entry.response.content.text;
    const body = text ? Buffer.from(text, entry.response.content.encoding === "base64" ? "base64" : "utf8") : null;
    const bytes = body?.byteLength ?? 0;
    let bodyFile: string | undefined;
    if (body && bytes) {
      bodyFile = `bodies/${String(index).padStart(5, "0")}.${classification.extension}`;
      await Bun.write(join(directory, bodyFile), body);
      bodyCount++;
      bodyBytes += bytes;
    }
    const evidence: string[] = [];
    if (manifestInfo.get(index)?.encrypted) evidence.push("manifest-content-protection");
    if (classification.kind === "media") {
      if (/(?:^|[/_-])cenc(?:[/_-]|$)/i.test(url.pathname)) evidence.push("media-path-cenc");
      if (encryptedPrefixes.some(prefix => prefix.origin === url.origin && url.pathname.startsWith(prefix.path)))
        evidence.push("linked-encrypted-manifest");
    }
    const encrypted = evidence.length > 0;
    const fragment =
      classification.kind === "media" &&
      (/\.(?:m4s|ts)$/.test(url.pathname) ||
        /(?:^|\/)(?:init|initialization|segment|chunk)[\w.-]*\.(?:mp4|m4s|webm)$/i.test(url.pathname));
    const complete =
      bytes > 0 &&
      entry.response.status >= 200 &&
      entry.response.status < 300 &&
      entry.response.status !== 206 &&
      !responseHeaders["content-range"] &&
      !fragment;
    const renderable = classification.kind === "media" && complete && !encrypted;
    const { content, ...responseMetadata } = entry.response;
    const { text: unusedBody, ...contentMetadata } = content;
    void unusedBody;
    const { request: unusedRequest, response: unusedResponse, ...harMetadata } = entry;
    void unusedRequest;
    void unusedResponse;
    requests.push({
      requestId: String(index),
      entryIndex: index,
      request: { ...entry.request, headers: requestHeaders },
      response: {
        ...responseMetadata,
        status: entry.response.status,
        mimeType: mime,
        headers: responseHeaders,
        content: contentMetadata,
      },
      bodyFile,
      bytes,
      encodedBytes: text ? Buffer.byteLength(text, "utf8") : 0,
      kind: classification.kind,
      manifestKind: classification.manifestKind,
      encrypted,
      encryptionEvidence: evidence,
      complete,
      renderable,
      range: { requested: requestHeaders.range ?? null, received: responseHeaders["content-range"] ?? null },
      har: {
        ...harMetadata,
        requestHeaders: entry.request.headers ?? [],
        responseHeaders: entry.response.headers ?? [],
        manifestMetadata: manifestInfo.get(index)?.metadata ?? null,
      },
    });
    assetCounts[classification.kind]++;
    if (classification.kind === "manifest") {
      manifestCount++;
      if (encrypted) encryptedManifestCount++;
    }
    if (classification.kind === "media") {
      mediaCount++;
      if (encrypted) encryptedMediaCount++;
      if (!complete) incompleteMediaCount++;
      if (renderable) clearCompleteMediaCount++;
    }
  }
  const captureIndexPath = join(directory, "capture-index.json");
  const summary: CapturedVideoNetworkSummary = {
    sourceId,
    sourcePath,
    captureIndexPath,
    entries: requests.length,
    pages: parsed.log.pages?.length ?? 0,
    bodyCount,
    bodyBytes,
    mediaCount,
    manifestCount,
    encryptedManifestCount,
    encryptedMediaCount,
    incompleteMediaCount,
    clearCompleteMediaCount,
    invalidManifestCount,
    assetCounts,
    playbackValidated: false,
  };
  const { entries: unusedEntries, ...logMetadata } = parsed.log;
  void unusedEntries;
  await Bun.write(
    captureIndexPath,
    JSON.stringify({ format: "bun-video-capture-v1", sourcePath, summary, har: logMetadata, requests }, null, 2),
  );
  if (options.catalog) {
    const catalog = options.catalog;
    if ("recordCapture" in catalog) {
      await catalog.recordCapture({ sourceId, captureIndexPath, directory, requests });
    } else
      catalog.db.transaction(() => {
        catalog.db
          .exec(`CREATE TABLE IF NOT EXISTS capture_entries(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL REFERENCES sources(id),entryIndex INTEGER NOT NULL,method TEXT NOT NULL,host TEXT NOT NULL,mimeType TEXT NOT NULL,status INTEGER NOT NULL,encodedBytes INTEGER NOT NULL,bytes INTEGER NOT NULL,bodyRef TEXT,manifestKind TEXT,encrypted INTEGER NOT NULL,complete INTEGER NOT NULL,UNIQUE(sourceId,entryIndex));
      CREATE TABLE IF NOT EXISTS captured_resources(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL REFERENCES sources(id),entryIndex INTEGER NOT NULL,kind TEXT NOT NULL,bodyRef TEXT NOT NULL,bytes INTEGER NOT NULL,UNIQUE(sourceId,entryIndex));
      CREATE INDEX IF NOT EXISTS capture_entries_source ON capture_entries(sourceId);`);
        catalog.registerSource({
          id: sourceId,
          privateRef: captureIndexPath,
          kind: "capture",
          title: "Captured video network",
        });
        for (const row of requests) {
          const bodyRef = row.bodyFile ? join(directory, row.bodyFile) : null;
          catalog.db
            .query("INSERT INTO capture_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              `${sourceId}:${row.entryIndex}`,
              sourceId,
              row.entryIndex,
              row.request.method,
              new URL(row.request.url).hostname,
              row.response.mimeType,
              row.response.status,
              row.encodedBytes,
              row.bytes,
              bodyRef,
              row.manifestKind,
              Number(row.encrypted),
              Number(row.complete),
            );
          if (bodyRef)
            catalog.db
              .query("INSERT INTO captured_resources VALUES(?,?,?,?,?,?)")
              .run(`${sourceId}:${row.entryIndex}`, sourceId, row.entryIndex, row.kind, bodyRef, row.bytes);
        }
      })();
  }
  return summary;
}
