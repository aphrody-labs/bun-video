// SPDX-License-Identifier: Apache-2.0
import { inspectDashManifest } from "./dash";

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  request: { method: string; url: string; headers?: HarHeader[] };
  response: {
    status: number;
    headers?: HarHeader[];
    content: { mimeType: string; text?: string; encoding?: string };
  };
}
export interface CapturedResource {
  entryIndex: number;
  host: string;
  mimeType: string;
  status: number;
  kind: "dash" | "hls" | "media";
}
export interface CapturedManifest extends CapturedResource {
  kind: "dash" | "hls";
  metadata:
    | ReturnType<typeof inspectDashManifest>
    | { kind: "hls"; segmentCount: number; variantCount: number; encrypted: boolean };
}

function validateEntries(value: unknown): HarEntry[] {
  const entries = (value as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Invalid HAR: log.entries must be an array.");
  for (const entry of entries) {
    if (
      typeof entry?.request?.method !== "string" ||
      typeof entry?.request?.url !== "string" ||
      !Number.isInteger(entry?.response?.status) ||
      typeof entry?.response?.content?.mimeType !== "string" ||
      (entry.response.content.text !== undefined && typeof entry.response.content.text !== "string") ||
      (entry.response.content.encoding !== undefined && entry.response.content.encoding !== "base64")
    )
      throw new Error("Invalid HAR entry structure.");
    try {
      new URL(entry.request.url);
    } catch {
      throw new Error("Invalid HAR request URL.");
    }
    for (const headers of [entry.request.headers, entry.response.headers]) {
      if (
        headers !== undefined &&
        (!Array.isArray(headers) ||
          headers.some(header => typeof header?.name !== "string" || typeof header?.value !== "string"))
      )
        throw new Error("Invalid HAR header structure.");
    }
  }
  return entries;
}

function mimeType(entry: HarEntry): string {
  const value = entry.response.content.mimeType.split(";")[0]!.trim().toLowerCase();
  return /^[a-z\d.+-]+\/[a-z\d.+-]+$/.test(value) ? value : "application/octet-stream";
}
function bodyBytes(entry: HarEntry): Uint8Array<ArrayBuffer> | null {
  const { text, encoding } = entry.response.content;
  if (text === undefined) return null;
  return new Uint8Array(Buffer.from(text, encoding === "base64" ? "base64" : "utf8"));
}
function header(headers: HarHeader[] | undefined, name: string): string | undefined {
  return headers?.find(item => item.name.toLowerCase() === name)?.value.trim();
}
function resourceKind(entry: HarEntry): CapturedResource["kind"] | null {
  const url = new URL(entry.request.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || entry.request.method !== "GET") return null;
  if (/licen[cs]|widevine|playready/i.test(url.hostname + url.pathname)) return null;
  const mime = mimeType(entry);
  if (mime === "application/dash+xml" || /\.mpd$/i.test(url.pathname)) return "dash";
  if (/mpegurl/.test(mime) || /\.m3u8$/i.test(url.pathname)) return "hls";
  if (/^(?:audio|video)\//.test(mime)) return "media";
  if (mime === "application/octet-stream" && /\.(?:mp4|m4[asv]|webm|ts|aac|mp3)$/i.test(url.pathname)) return "media";
  return null;
}

function descriptor(entry: HarEntry, entryIndex: number): CapturedResource | null {
  const kind = resourceKind(entry);
  if (!kind || ![200, 206].includes(entry.response.status) || entry.response.content.text === undefined) return null;
  return {
    entryIndex,
    kind,
    host: new URL(entry.request.url).hostname,
    mimeType: mimeType(entry),
    status: entry.response.status,
  };
}

function requestedRange(value: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? [Math.max(0, size - suffix), size - 1] : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return [start, Math.min(end, size - 1)];
}

export class CapturedHar {
  #entries: HarEntry[];
  #manifestIndices = new Set<number>();
  readonly summary: {
    entryCount: number;
    hosts: Record<string, number>;
    mimeTypes: Record<string, number>;
    statusClasses: Record<string, number>;
    jsonResponses: number;
    invalidJsonResponses: number;
    invalidManifestResponses: number;
    manifests: CapturedManifest[];
    replayableResourceCount: number;
    playbackValidated: false;
  };

  constructor(value: unknown) {
    this.#entries = validateEntries(value);
    const hosts: Record<string, number> = {},
      mimeTypes: Record<string, number> = {},
      statusClasses: Record<string, number> = {};
    const manifests: CapturedManifest[] = [];
    let jsonResponses = 0,
      invalidJsonResponses = 0,
      invalidManifestResponses = 0,
      replayableResourceCount = 0;
    for (const [entryIndex, entry] of this.#entries.entries()) {
      const host = new URL(entry.request.url).hostname;
      hosts[host] = (hosts[host] ?? 0) + 1;
      const mime = mimeType(entry);
      mimeTypes[mime] = (mimeTypes[mime] ?? 0) + 1;
      const statusClass = entry.response.status === 0 ? "unavailable" : `${Math.floor(entry.response.status / 100)}xx`;
      statusClasses[statusClass] = (statusClasses[statusClass] ?? 0) + 1;
      if (/\/(?:[\w.+-]*\+)?json$/.test(mime) && entry.response.content.text !== undefined) {
        try {
          JSON.parse(new TextDecoder().decode(bodyBytes(entry)!));
          jsonResponses++;
        } catch {
          invalidJsonResponses++;
        }
      }
      const resource = descriptor(entry, entryIndex);
      if (!resource) continue;
      replayableResourceCount++;
      if (resource.kind === "media") continue;
      const text = new TextDecoder().decode(bodyBytes(entry)!);
      try {
        if (resource.kind === "dash")
          manifests.push({ ...resource, kind: "dash", metadata: inspectDashManifest(text) });
        else if (text.trimStart().startsWith("#EXTM3U"))
          manifests.push({
            ...resource,
            kind: "hls",
            metadata: {
              kind: "hls",
              segmentCount: (text.match(/^#EXTINF:/gm) ?? []).length,
              variantCount: (text.match(/^#EXT-X-STREAM-INF:/gm) ?? []).length,
              encrypted: /^#EXT-X-KEY:(?![^\r\n]*METHOD=NONE)/m.test(text),
            },
          });
        else invalidManifestResponses++;
      } catch {
        invalidManifestResponses++;
      }
    }
    this.summary = {
      entryCount: this.#entries.length,
      hosts,
      mimeTypes,
      statusClasses,
      jsonResponses,
      invalidJsonResponses,
      invalidManifestResponses,
      manifests,
      replayableResourceCount,
      playbackValidated: false,
    };
    this.#manifestIndices = new Set(manifests.map(item => item.entryIndex));
  }

  selectManifest(options: { kind?: "dash" | "hls"; index?: number } = {}): CapturedManifest | undefined {
    return this.summary.manifests.find(
      item =>
        (!options.kind || item.kind === options.kind) &&
        (options.index === undefined || item.entryIndex === options.index),
    );
  }

  readManifest(entryIndex: number): string {
    if (!this.#manifestIndices.has(entryIndex))
      throw new Error("Requested entry is not a validated captured manifest.");
    return new TextDecoder().decode(bodyBytes(this.#entries[entryIndex]!)!);
  }

  resourceForUrl(exactUrl: string): CapturedResource | null {
    for (const [entryIndex, entry] of this.#entries.entries()) {
      if (entry.request.url === exactUrl) {
        const resource = descriptor(entry, entryIndex);
        if (resource) return resource;
      }
    }
    return null;
  }

  replayResource(entryIndex: number, range?: string): Response | null {
    const entry = this.#entries[entryIndex];
    if (!entry || !descriptor(entry, entryIndex)) return null;
    return this.replay(entry.request.url, range);
  }

  replay(exactUrl: string, range?: string): Response | null {
    if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return null;
    const candidates = this.#entries.filter(
      (entry, index) => entry.request.url === exactUrl && descriptor(entry, index),
    );
    if (range) {
      for (const entry of candidates) {
        if (entry.response.status !== 206) continue;
        const bytes = bodyBytes(entry)!;
        const contentRange = header(entry.response.headers, "content-range");
        const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
        if (!match) continue;
        const capturedStart = Number(match[1]),
          capturedEnd = Number(match[2]);
        const total = match[3] === "*" ? undefined : Number(match[3]);
        if (
          !Number.isSafeInteger(capturedStart) ||
          !Number.isSafeInteger(capturedEnd) ||
          capturedEnd < capturedStart ||
          capturedEnd - capturedStart + 1 !== bytes.byteLength ||
          (total !== undefined && (!Number.isSafeInteger(total) || total <= capturedEnd))
        )
          continue;
        const exact = header(entry.request.headers, "range") === range;
        const bounds = total !== undefined ? requestedRange(range, total) : exact ? [capturedStart, capturedEnd] : null;
        if (!bounds || bounds[0]! < capturedStart || bounds[1]! > capturedEnd) continue;
        const [start, end] = bounds as [number, number];
        const body = bytes.slice(start - capturedStart, end - capturedStart + 1);
        const headers = {
          "Content-Type": mimeType(entry),
          "Content-Range": `bytes ${start}-${end}/${match[3]}`,
          "Content-Length": String(body.byteLength),
          "Accept-Ranges": "bytes",
        };
        return new Response(body, { status: 206, headers });
      }
    }
    const full = candidates.find(entry => entry.response.status === 200 && !header(entry.request.headers, "range"));
    if (!full) return null;
    const bytes = bodyBytes(full)!;
    if (range) {
      const bounds = requestedRange(range, bytes.byteLength);
      if (!bounds)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.byteLength}` },
        });
      const [start, end] = bounds;
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": mimeType(full),
          "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
        },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mimeType(full),
        "Content-Length": String(bytes.byteLength),
        "Accept-Ranges": "bytes",
      },
    });
  }
}

export async function loadHarCapture(absolutePath: string): Promise<CapturedHar> {
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(absolutePath)) throw new Error("HAR capture path must be absolute.");
  let value: unknown;
  try {
    value = await Bun.file(absolutePath).json();
  } catch {
    throw new Error("Unable to read a valid HAR capture.");
  }
  return new CapturedHar(value);
}
