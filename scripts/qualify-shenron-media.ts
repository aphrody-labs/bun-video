#!/usr/bin/env bun
// Qualifies Bun.Image and Bun.Video against a local image corpus (Shenron by default).
// Corpus images are only read; derived media lives in a temporary directory removed on exit.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const IMAGE_PATTERN = "**/*.{png,jpg,jpeg,webp,gif}";
const SKIP = /(^|\/)(node_modules|target|\.git|\.next|dist)\//;
const MAX_PIXELS = 8192 * 8192;
const MAX_BYTES = 32 * 1024 * 1024;

export interface ImageResult {
  path: string;
  bytes: number;
  ok: boolean;
  width?: number;
  height?: number;
  format?: string;
  encoded?: Record<string, number>;
  encodeErrors?: Record<string, string>;
  ms?: number;
  error?: string;
}

export interface VideoReadback {
  available: boolean;
  metadata?: { width: number; height: number; duration: number; codec?: string; container?: string };
  frameWidth?: number;
  frameHeight?: number;
  frameFormat?: string;
  frames?: number;
  framesBytes?: number;
  gifBytes?: number;
  ms?: number;
  error?: string;
}

export interface Report {
  corpus: string;
  runtime: { bun: string; image: boolean; video: boolean };
  discovered: number;
  sampled: number;
  decoded: number;
  failures: { path: string; error: string }[];
  formats: Record<string, number>;
  encodeBytes: Record<string, number>;
  encodeFailures: Record<string, { count: number; error: string }>;
  slideshow?: { encoder: string; path: string; frames: number; bytes: number; ms: number; error?: string };
  readback?: VideoReadback;
  timingsMs: Record<string, number>;
  rssPeakMiB: number;
}

/** Deterministic bounded sample: walk with Bun.Glob, keep every k-th path after sorting. */
export async function sampleImages(root: string, limit: number): Promise<{ discovered: number; paths: string[] }> {
  const all: string[] = [];
  for await (const rel of new Bun.Glob(IMAGE_PATTERN).scan({ cwd: root, onlyFiles: true, dot: false })) {
    if (!SKIP.test(rel)) all.push(rel);
  }
  all.sort();
  const step = Math.max(1, Math.floor(all.length / Math.max(1, limit)));
  const paths: string[] = [];
  for (let i = 0; i < all.length && paths.length < limit; i += step) paths.push(join(root, all[i]));
  return { discovered: all.length, paths };
}

/** Metadata, resize and webp/avif/jpeg encode of one image. Only sizes are retained. */
export async function qualifyImage(
  path: string,
  formats: readonly ("webp" | "avif" | "jpeg")[] = ["webp", "avif", "jpeg"],
): Promise<ImageResult> {
  const file = Bun.file(path);
  const bytes = file.size;
  const t = performance.now();
  try {
    if (bytes > MAX_BYTES) throw new Error(`skipped: ${bytes} bytes exceeds ${MAX_BYTES}`);
    const meta = await new Bun.Image(file, { maxPixels: MAX_PIXELS }).metadata();
    const encoded: Record<string, number> = {};
    const encodeErrors: Record<string, string> = {};
    for (const f of formats) {
      const img = new Bun.Image(file, { maxPixels: MAX_PIXELS }).resize(256, 256, { fit: "inside" });
      try {
        const out = await (
          f === "webp"
            ? img.webp({ quality: 75 })
            : f === "avif"
              ? img.avif({ quality: 50 })
              : img.jpeg({ quality: 80 })
        ).bytes();
        encoded[f] = out.byteLength;
      } catch (e) {
        // A missing optional encoder (AVIF) is a codec limit, not a decode failure.
        if (f === formats[0]) throw e;
        encodeErrors[f] = String((e as Error)?.message ?? e);
      }
    }
    return {
      path,
      bytes,
      ok: true,
      width: meta.width,
      height: meta.height,
      format: meta.format,
      encoded,
      encodeErrors,
      ms: performance.now() - t,
    };
  } catch (e) {
    return { path, bytes, ok: false, error: String((e as Error)?.message ?? e), ms: performance.now() - t };
  }
}

/** Fixed-size (stretched; Bun.Image supports only fill/inside) 320x240 PNG frame for the slideshow. */
export async function slideshowFrame(path: string | Uint8Array, width = 320, height = 240): Promise<Uint8Array> {
  const src = typeof path === "string" ? Bun.file(path) : path;
  return new Bun.Image(src, { maxPixels: MAX_PIXELS }).resize(width, height, { fit: "fill" }).png().bytes();
}

export function findFFmpeg(): string | null {
  return Bun.env.BUN_VIDEO_FFMPEG ?? Bun.which("ffmpeg");
}

/**
 * Bun.Video decodes but has no image-sequence encoder, so frames are piped to an FFmpeg
 * executable (the same BUN_VIDEO_FFMPEG override the package's encoder honours).
 */
export async function encodeSlideshow(frames: Uint8Array[], output: string, fps = 2, ffmpeg = findFFmpeg()) {
  if (!ffmpeg) throw new Error("No FFmpeg executable (set BUN_VIDEO_FFMPEG)");
  const child = Bun.spawn(
    [
      ffmpeg,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      output,
    ],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  for (const f of frames) {
    child.stdin.write(f);
    await child.stdin.flush();
  }
  await child.stdin.end();
  const code = await child.exited;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${await stderr}`);
  return { encoder: `${ffmpeg} libx264`, bytes: Bun.file(output).size };
}

export async function readBack(path: string, expectedFrames: number, fps: number): Promise<VideoReadback> {
  const V = (Bun as any).Video;
  if (!V?.available) return { available: false, error: "Bun.Video unavailable in this runtime" };
  const t = performance.now();
  try {
    const video = new V(path);
    const metadata = await video.metadata();
    const frame = video.frame(0.25).resize(160).webp({ quality: 70 });
    const still = await frame.bytes();
    const stillMeta = await new Bun.Image(still).metadata();
    const step = 1 / fps;
    const frames = await video.frames({
      start: 0,
      end: expectedFrames * step,
      step,
      maxFrames: Math.min(64, expectedFrames),
    });
    let framesBytes = 0;
    for (const f of frames) framesBytes += f.bytes.byteLength;
    let gifBytes: number | undefined;
    try {
      gifBytes = (await video.gif({ start: 0, duration: Math.min(5, metadata.duration), fps: 4, width: 160 }))
        .byteLength;
    } catch {}
    return {
      available: true,
      metadata: {
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        codec: metadata.codec,
        container: metadata.container,
      },
      frameWidth: stillMeta.width,
      frameHeight: stillMeta.height,
      frameFormat: stillMeta.format,
      frames: frames.length,
      framesBytes,
      gifBytes,
      ms: performance.now() - t,
    };
  } catch (e) {
    return { available: true, error: String((e as Error)?.message ?? e), ms: performance.now() - t };
  }
}

export async function qualifyCorpus(
  root: string,
  opts: { limit?: number; slides?: number; fps?: number } = {},
): Promise<Report> {
  const limit = opts.limit ?? 120;
  const slides = opts.slides ?? 12;
  const fps = opts.fps ?? 2;
  const timings: Record<string, number> = {};
  let rssPeak = process.memoryUsage().rss;
  const lap = async <T>(name: string, fn: () => Promise<T>) => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }
  };

  const { discovered, paths } = await lap("glob", () => sampleImages(root, limit));
  const results: ImageResult[] = [];
  await lap("images", async () => {
    for (const p of paths) {
      results.push(await qualifyImage(p));
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }
  });
  const formats: Record<string, number> = {};
  const encodeBytes: Record<string, number> = {};
  const encodeFailures: Report["encodeFailures"] = {};
  for (const r of results.filter(r => r.ok)) {
    formats[r.format!] = (formats[r.format!] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.encoded!)) encodeBytes[k] = (encodeBytes[k] ?? 0) + v;
    for (const [k, error] of Object.entries(r.encodeErrors!))
      encodeFailures[k] = { count: (encodeFailures[k]?.count ?? 0) + 1, error };
  }
  const report: Report = {
    corpus: root,
    runtime: { bun: Bun.version, image: typeof Bun.Image === "function", video: !!(Bun as any).Video?.available },
    discovered,
    sampled: paths.length,
    decoded: results.filter(r => r.ok).length,
    failures: results.filter(r => !r.ok).map(r => ({ path: relative(root, r.path), error: r.error! })),
    formats,
    encodeBytes,
    encodeFailures,
    timingsMs: timings,
    rssPeakMiB: 0,
  };

  const dir = mkdtempSync(join(tmpdir(), "shenron-media-"));
  try {
    const usable = results.filter(r => r.ok && r.format !== "gif").slice(0, slides);
    const frames: Uint8Array[] = [];
    await lap("slideshowFrames", async () => {
      for (const r of usable) frames.push(await slideshowFrame(r.path));
    });
    const mp4 = join(dir, "slideshow.mp4");
    const t = performance.now();
    try {
      const enc = await lap("encode", () => encodeSlideshow(frames, mp4, fps));
      report.slideshow = {
        encoder: enc.encoder,
        path: "<tmp>/slideshow.mp4",
        frames: frames.length,
        bytes: enc.bytes,
        ms: Math.round(performance.now() - t),
      };
      report.readback = await lap("readback", () => readBack(mp4, frames.length, fps));
    } catch (e) {
      report.slideshow = {
        encoder: "ffmpeg",
        path: "",
        frames: frames.length,
        bytes: 0,
        ms: Math.round(performance.now() - t),
        error: String((e as Error)?.message ?? e),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  report.rssPeakMiB = Math.round(rssPeak / 1048576);
  return report;
}

if (import.meta.main) {
  const root = Bun.argv[2] ?? Bun.env.SHENRON_CORPUS ?? "/home/ubuntu/src/shenron";
  if (!existsSync(root)) {
    console.error(`Corpus not found: ${root}`);
    process.exit(2);
  }
  const limit = Number(Bun.env.SHENRON_SAMPLE ?? 120);
  const report = await qualifyCorpus(root, { limit });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.decoded > 0 && !report.slideshow?.error ? 0 : 1);
}
