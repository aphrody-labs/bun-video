export type VideoArchiveFormat = "tar" | "tar.gz" | "zip";
export type VideoCompression = "gzip" | "zstd" | "brotli" | "deflate";

export interface VideoArchiveEntry {
  readonly [path: string]: string | Uint8Array | ArrayBuffer | Blob;
}
export interface VideoArchiveBytesEntry {
  readonly [path: string]: string | Uint8Array | ArrayBuffer;
}

export function createVideoArchive(
  entries: VideoArchiveBytesEntry,
  format: VideoArchiveFormat = "tar.gz",
  options: { level?: number; mtime?: number | Date } = {},
): Bun.Archive {
  if (!["tar", "tar.gz", "zip"].includes(format)) throw new TypeError("Unknown video archive format");
  return new Bun.Archive(entries, {
    format: format === "zip" ? "zip" : "tar",
    ...(format === "tar.gz" ? { compress: "gzip", level: options.level ?? 6 } : {}),
    ...(options.mtime === undefined ? {} : { mtime: options.mtime }),
  });
}

/** Package media, manifests and thumbnails with Bun's native archive/compression stack. */
export async function writeVideoArchive(
  path: string,
  entries: VideoArchiveEntry,
  format: VideoArchiveFormat = "tar.gz",
): Promise<void> {
  const resolved: Record<string, string | Uint8Array | ArrayBuffer> = {};
  for (const [name, input] of Object.entries(entries))
    resolved[name] = input instanceof Blob ? await input.arrayBuffer() : input;
  await Bun.write(path, await createVideoArchive(resolved, format).bytes());
}

export function compressVideoBytes(data: Uint8Array | ArrayBuffer | string, format: VideoCompression): Promise<Buffer> {
  switch (format) {
    case "gzip":
      return Promise.resolve(gzipSync(data));
    case "brotli":
      return Promise.resolve(brotliCompressSync(data));
    case "zstd":
      return Promise.resolve(zstdCompressSync(data));
    case "deflate":
      return Promise.resolve(deflateSync(data));
  }
}

export function decompressVideoBytes(data: Uint8Array | ArrayBuffer, format: VideoCompression): Promise<Buffer> {
  switch (format) {
    case "gzip":
      return Promise.resolve(gunzipSync(data));
    case "brotli":
      return Promise.resolve(brotliDecompressSync(data));
    case "zstd":
      return Promise.resolve(zstdDecompressSync(data));
    case "deflate":
      return Promise.resolve(inflateSync(data));
  }
}
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
