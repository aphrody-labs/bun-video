import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { VideoCatalog } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";
import { exportVideoDataset, queryVideoDataset, type VideoDatasetTable } from "./video-dataset";

const tables: VideoDatasetTable[] = [
  "sources",
  "providers",
  "capabilities",
  "jobs",
  "qualifications",
  "capture_entries",
  "captured_resources",
];
const sha = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
async function boundedR2<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("R2 operation exceeded its 20-second deadline")), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export interface VideoPublicationAsset {
  key: string;
  url: string;
  bytes: number;
  sha256: string;
}
export interface VideoPublication {
  format: "bun-video-publication-v1";
  generatedAt: string;
  bucket: string;
  assets: VideoPublicationAsset[];
  records: number;
  documents: number;
}

export function validateVideoPublicationTarget(bucket: string, prefix: string, publicBase: string) {
  const base = new URL(publicBase);
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-z0-9][a-z0-9/_-]{0,100}$/.test(prefix) ||
    prefix.includes("//") ||
    prefix.endsWith("/")
  )
    throw new TypeError("Invalid publication bucket/prefix");
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    base.hostname.endsWith(".r2.dev") ||
    base.hostname.endsWith(".r2.cloudflarestorage.com")
  )
    throw new TypeError("Publication requires an HTTPS custom domain origin");
  return base.origin;
}

/** Builds a fresh portable database from the public SELECT allowlist, never copying the private catalog. */
export function exportPublicVideoCatalog(catalog: VideoCatalog, output: string): { output: string; records: number };
export function exportPublicVideoCatalog(
  catalog: NeonVideoCatalog,
  output: string,
): Promise<{ output: string; records: number }>;
export function exportPublicVideoCatalog(
  catalog: VideoCatalog | NeonVideoCatalog,
  output: string,
): { output: string; records: number } | Promise<{ output: string; records: number }>;
export function exportPublicVideoCatalog(catalog: VideoCatalog | NeonVideoCatalog, output: string) {
  if (!isAbsolute(output) || output.includes("\0") || existsSync(output))
    throw new TypeError("Fresh absolute SQLite output required");
  if (catalog instanceof NeonVideoCatalog) return exportPublicVideoCatalogNeon(catalog, output);
  const db = new Database(output, { create: true });
  let records = 0;
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE publication_metadata(format TEXT NOT NULL,generatedAt TEXT NOT NULL); INSERT INTO publication_metadata VALUES('bun-video-public-catalog-v1',datetime('now'));",
    );
    db.transaction(() => {
      for (const table of tables) {
        const first = queryVideoDataset(catalog, { table, limit: 1000 });
        if (first.total > 1000000) throw new RangeError("Catalog exceeds publication bounds");
        db.exec(`CREATE TABLE "${table}" (${first.columns.map(column => `"${column}"`).join(",")});`);
        const insert = db.query(`INSERT INTO "${table}" VALUES(${first.columns.map(() => "?").join(",")})`);
        for (let offset = 0; offset < first.total; offset += 1000) {
          const page = offset === 0 ? first : queryVideoDataset(catalog, { table, limit: 1000, offset });
          for (const row of page.rows) {
            insert.run(...first.columns.map(column => row[column] as string | number | null));
            records++;
          }
        }
      }
    })();
  } finally {
    db.close();
  }
  return { output, records };
}

async function exportPublicVideoCatalogNeon(catalog: NeonVideoCatalog, output: string) {
  const db = new Database(output, { create: true });
  let records = 0;
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE publication_metadata(format TEXT NOT NULL,generatedAt TEXT NOT NULL); INSERT INTO publication_metadata VALUES('bun-video-public-catalog-v1',datetime('now'));",
    );
    for (const table of tables) {
      const first = await queryVideoDataset(catalog, { table, limit: 1000 });
      if (first.total > 1000000) throw new RangeError("Catalog exceeds publication bounds");
      db.exec(`CREATE TABLE "${table}" (${first.columns.map(column => `"${column}"`).join(",")});`);
      const insert = db.query(`INSERT INTO "${table}" VALUES(${first.columns.map(() => "?").join(",")})`);
      for (let offset = 0; offset < first.total; offset += 1000) {
        const page = offset === 0 ? first : await queryVideoDataset(catalog, { table, limit: 1000, offset });
        db.transaction(() => {
          for (const row of page.rows) {
            insert.run(...first.columns.map(column => row[column] as string | number | null));
            records++;
          }
        })();
      }
    }
  } finally {
    db.close();
  }
  return { output, records };
}

/** Generates curated exports itself; arbitrary local files, raw HARs and secret databases cannot enter this API. */
export async function publishBunVideoExports(
  catalog: VideoCatalog | NeonVideoCatalog,
  options: {
    outputDirectory: string;
    bucket?: string;
    prefix?: string;
    publicBase?: string;
    includeText?: boolean;
    environmentFile?: string;
  },
): Promise<VideoPublication> {
  const bucket = options.bucket ?? "aphrody-dist";
  const prefix = options.prefix ?? "bun-video";
  const base = validateVideoPublicationTarget(bucket, prefix, options.publicBase ?? "https://dist.aphrody.app");
  if (!isAbsolute(options.outputDirectory) || options.outputDirectory.includes("\0"))
    throw new TypeError("Absolute publication directory required");
  const { createR2Client, loadCloudflareEnvironment } = await import("@aphrody/bun-cloudflare/api");
  const work = join(options.outputDirectory, crypto.randomUUID());
  mkdirSync(work, { recursive: true });
  const snapshot = await exportPublicVideoCatalog(catalog, join(work, "catalog.sqlite"));
  const generated: { name: string; path: string; type: string }[] = [
    { name: "catalog.sqlite", path: snapshot.output, type: "application/vnd.sqlite3" },
  ];
  let documents = 0;
  for (const [format, extension, type] of [
    ["json", "json", "application/json"],
    ["jsonl", "jsonl", "application/x-ndjson"],
    ["sql", "sql", "application/sql"],
    ["wiki", "md", "text/markdown; charset=utf-8"],
  ] as const) {
    const result = await exportVideoDataset(catalog, {
      format,
      output: join(work, `dataset.${extension}`),
      includeText: options.includeText,
    });
    documents = result.documents;
    generated.push({ name: `dataset.${extension}`, path: result.output, type });
  }
  const s3 = createR2Client({ bucket, env: await loadCloudflareEnvironment(options.environmentFile) });
  const publication: VideoPublication = {
    format: "bun-video-publication-v1",
    generatedAt: new Date().toISOString(),
    bucket,
    records: snapshot.records,
    documents,
    assets: [],
  };
  for (const asset of generated) {
    const data = await Bun.file(asset.path).bytes();
    if (data.length > 64 * 1024 * 1024) throw new RangeError("Publication asset exceeds 64 MiB");
    const key = `${prefix}/${asset.name}`;
    await boundedR2(s3.write(key, data, { type: asset.type }));
    const stored = await boundedR2(s3.file(key).bytes());
    if (sha(stored) !== sha(data)) throw new Error("R2 read-back integrity verification failed");
    const url = `${base}/${key}`;
    const response = await fetch(`${url}?sha256=${sha(data)}`, {
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
    if (!response.ok || sha(new Uint8Array(await response.arrayBuffer())) !== sha(data))
      throw new Error("Public custom-domain integrity verification failed");
    publication.assets.push({ key, url, bytes: data.length, sha256: sha(data) });
  }
  const manifest = JSON.stringify(publication, null, 2) + "\n";
  await boundedR2(s3.write(`${prefix}/manifest.json`, manifest, { type: "application/json" }));
  const receipt = await fetch(`${base}/${prefix}/manifest.json?t=${Date.now()}`, {
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!receipt.ok || (await receipt.text()) !== manifest) throw new Error("Publication manifest verification failed");
  await Bun.write(join(work, "manifest.json"), manifest);
  return publication;
}
