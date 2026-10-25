import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { extname, join, resolve } from "node:path";
import { createWatchDelivery, exportShenronAssets } from "./watch-shenron";
import { cleanWatch, watch, type WatchOptions, type WatchReport } from "./watch";

export interface CatalogueEntry {
  /** Stable episode key; becomes the output directory name. */
  id: string;
  source: string;
  captions?: string;
  /** Database wiki ID. With `sourceUrl` and `options.shenron`, a Shenron delivery is exported. */
  episodeId?: number;
  sourceUrl?: string;
  /** Normalized transcript language (`fr`, `ja`) for the delivered VTT track. */
  subtitleLanguage?: string;
}

export interface CatalogueOptions extends Omit<WatchOptions, "source" | "captions" | "outDir"> {
  /** Output root; each episode gets `<out>/<id>/` with `frames/` and `watch.json`. */
  out: string;
  /** Concurrent episodes; defaults to a quarter of the cores (at least 1, at most 4). */
  concurrency?: number;
  /** Re-run entries even when a matching cached report exists. */
  force?: boolean;
  /** Export `<out>/<id>/delivery/` (original-size PNGs, VTT, delivery.json) for entries with episodeId and sourceUrl. */
  shenron?: { publicAssetOrigin: string; maxFrames?: number };
}

export interface CatalogueResult {
  id: string;
  status: "done" | "cached" | "failed";
  elapsedMs: number;
  frames?: number;
  delivery?: boolean;
  transcriptSegments?: number;
  error?: string;
}

const VIDEO = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Reads `[{ id, source, captions? }]` from a JSON file, or one entry per video file in a directory. */
export async function loadCatalogue(input: string): Promise<CatalogueEntry[]> {
  const path = resolve(input);
  const info = await stat(path);
  const entries: CatalogueEntry[] = info.isDirectory()
    ? (await readdir(path))
        .filter(name => VIDEO.has(extname(name).toLowerCase()))
        .sort()
        .map(name => ({ id: name.slice(0, name.length - extname(name).length), source: join(path, name) }))
    : ((await Bun.file(path).json()) as CatalogueEntry[]);
  if (!Array.isArray(entries)) throw new Error("A catalogue file must be a JSON array of { id, source }");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !ID.test(entry.id))
      throw new Error(`Invalid catalogue id: ${String(entry?.id)}`);
    if (typeof entry.source !== "string" || !entry.source) throw new Error(`Catalogue entry ${entry.id} has no source`);
    if (seen.has(entry.id)) throw new Error(`Duplicate catalogue id: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}

/** Cache key: the source's identity and every option that changes the output. */
async function cacheKey(entry: CatalogueEntry, options: CatalogueOptions): Promise<string> {
  let identity = entry.source;
  if (!/^https?:/.test(entry.source)) {
    const info = await stat(resolve(entry.source));
    identity = `${resolve(entry.source)}:${info.size}:${info.mtimeMs}`;
  }
  const { out: _out, concurrency: _concurrency, force: _force, signal: _signal, ...rest } = options;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify([
      identity,
      entry.captions ?? null,
      entry.episodeId ?? null,
      entry.sourceUrl ?? null,
      entry.subtitleLanguage ?? null,
      rest,
    ]),
  );
  return hasher.digest("hex");
}

async function runEntry(entry: CatalogueEntry, options: CatalogueOptions): Promise<CatalogueResult> {
  const started = performance.now();
  const dir = join(resolve(options.out), entry.id);
  const reportPath = join(dir, "watch.json");
  const key = await cacheKey(entry, options).catch(() => null);
  try {
    if (key && !options.force && (await Bun.file(reportPath).exists())) {
      const cached = (await Bun.file(reportPath).json()) as { cacheKey?: string; report: WatchReport };
      if (cached.cacheKey === key && cached.report.frames.every(frame => Bun.file(frame.path).size > 0))
        return {
          id: entry.id,
          status: "cached",
          elapsedMs: 0,
          frames: cached.report.frames.length,
          delivery: await Bun.file(join(dir, "delivery", "delivery.json")).exists(),
          transcriptSegments: cached.report.transcript.length,
        };
    }
    // A stale or forced rerun replaces the previous work directory instead of piling up beside it.
    const previous = (await Bun.file(reportPath)
      .json()
      .catch(() => null)) as { report?: { workDir?: string } } | null;
    if (previous?.report?.workDir?.startsWith(dir)) await cleanWatch({ workDir: previous.report.workDir });
    await mkdir(dir, { recursive: true });
    const { out: _out, concurrency: _concurrency, force: _force, shenron: _shenron, ...watchOptions } = options;
    const report = await watch({ ...watchOptions, source: entry.source, captions: entry.captions, outDir: dir });
    if (report.errors.length && !report.frames.length && !report.transcript.length) {
      await cleanWatch(report);
      throw new Error(report.errors.join("; "));
    }
    let delivery = false;
    if (options.shenron && entry.episodeId !== undefined && entry.sourceUrl) {
      const deliveryDir = join(dir, "delivery");
      await rm(deliveryDir, { recursive: true, force: true });
      const assets = await exportShenronAssets(report, {
        outDir: deliveryDir,
        maxFrames: options.shenron.maxFrames,
        subtitleLanguage: entry.subtitleLanguage,
      });
      const origin = options.shenron.publicAssetOrigin.replace(/\/$/, "");
      const manifest = createWatchDelivery(assets, {
        episodeId: entry.episodeId,
        sourceUrl: entry.sourceUrl,
        publicAssetOrigin: origin,
        assetUrls: path => `${origin}/episodes/${entry.episodeId}/${path}`,
      });
      await Bun.write(join(deliveryDir, "delivery.json"), JSON.stringify(manifest, null, 2));
      delivery = true;
    }
    await Bun.write(reportPath, JSON.stringify({ cacheKey: key, report }, null, 2));
    return {
      id: entry.id,
      status: "done",
      elapsedMs: Math.round(performance.now() - started),
      frames: report.frames.length,
      delivery,
      transcriptSegments: report.transcript.length,
    };
  } catch (error) {
    return {
      id: entry.id,
      status: "failed",
      elapsedMs: Math.round(performance.now() - started),
      error: (error as Error).message,
    };
  }
}

/**
 * Watches every entry with bounded concurrency. One failing episode never stops the rest, and a rerun
 * skips episodes whose source and options are unchanged, so an interrupted catalogue resumes.
 */
export async function watchCatalogue(entries: CatalogueEntry[], options: CatalogueOptions): Promise<CatalogueResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.min(4, Math.floor(cpus().length / 4)), entries.length || 1),
  );
  const results: CatalogueResult[] = new Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < entries.length) {
        const index = next++;
        results[index] = await runEntry(entries[index]!, options);
      }
    }),
  );
  await mkdir(resolve(options.out), { recursive: true });
  await Bun.write(join(resolve(options.out), "catalogue.json"), JSON.stringify(results, null, 2));
  return results;
}
