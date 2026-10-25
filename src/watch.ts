/// <reference path="./media-runtime.d.ts" />
/**
 * Native `watch`: a video URL or local file becomes timestamped frames and a transcript for an agent.
 *
 * Port of the claude-video `/watch` local engine onto `Bun.Video` and `Bun.Image`. Nothing here spawns
 * FFmpeg, ffprobe or Deno: probing, frame decoding, resizing, JPEG encoding and PCM audio extraction are
 * native, and captions come from sidecar files, yt-dlp's caption metadata or an optional Whisper API.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { parseSubtitle } from "../scripts/episode-subtitles";
import { downloadYtDlp, extractYtDlp, type YtDlpResult } from "./ytdlp";

export type WatchDetail = "transcript" | "efficient" | "balanced" | "token-burner";
export type WhisperBackend = "groq" | "openai";

export interface FrameRecord {
  index: number;
  path: string;
  /** Requested source time; Bun.Video decodes the frame at or immediately before it. */
  timestampSeconds: number;
  reason: "uniform" | "scene-change" | "first-frame" | "sampled" | "transcript-cue";
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface WatchOptions {
  source: string;
  detail?: WatchDetail;
  maxFrames?: number;
  resolution?: number;
  fps?: number;
  start?: number;
  end?: number;
  timestamps?: number[];
  dedup?: boolean;
  whisper?: WhisperBackend | "none";
  /** Caption file (.vtt, .srt or .ass) to use instead of a sidecar or yt-dlp track. */
  captions?: string;
  subLang?: string;
  cookiesFile?: string;
  outDir?: string;
  signal?: AbortSignal;
}

export interface WatchReport {
  source: string;
  workDir: string;
  localMedia: string | null;
  title?: string;
  uploader?: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  detail: WatchDetail;
  focus: { start: number; end: number } | null;
  frames: FrameRecord[];
  frameEngine: string;
  candidateCount: number;
  dedupedCount: number;
  cueFrames: number;
  transcript: Segment[];
  transcriptSource: string | null;
  transcriptState: string;
  errors: string[];
  warnings: string[];
}

export const MAX_FPS = 2;
export const SCENE_THRESHOLD = 0.1;
export const SCENE_MIN_FRAMES = 8;
export const DEDUP_THUMB = 16;
export const DEDUP_THRESHOLD = 2;
const PROBE_LIMIT = 600;
const MAX_READ_DIMENSION = 1998;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const WHISPER_CHUNK_SECONDS = 30;
const WHISPER_MAX_SECONDS = 1800;

const DETAIL_CAPS: Record<WatchDetail, number | null> = {
  transcript: 0,
  efficient: 50,
  balanced: 100,
  "token-burner": null,
};

/** Frame cap for a detail level; `null` is uncapped. */
export function frameCap(detail: WatchDetail): number | null {
  return DETAIL_CAPS[detail];
}

/** Parses a finite non-negative SS, MM:SS or HH:MM:SS time. */
export function parseTime(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  const parts = String(value).trim().split(":");
  const invalid = () => new Error("Invalid time; expected finite non-negative SS, MM:SS, or HH:MM:SS.");
  if (parts.length > 3) throw invalid();
  const numbers = parts.map(part => (/^\d+(\.\d+)?$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some(n => !Number.isFinite(n) || n < 0)) throw invalid();
  if (parts.length > 1 && (numbers.slice(1).some(n => n >= 60) || numbers.slice(0, -1).some(n => !Number.isInteger(n))))
    throw invalid();
  return numbers.reduceRight((total, n, i) => total + n * 60 ** (numbers.length - 1 - i), 0);
}

export function parseTimestamps(value: string | null | undefined): number[] {
  if (!value) return [];
  const out = new Set<number>();
  for (const token of value.split(",")) {
    const seconds = parseTime(token.trim());
    if (seconds !== undefined) out.add(seconds);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pair = (n: number) => String(n).padStart(2, "0");
  return hours ? `${hours}:${pair(minutes)}:${pair(sec)}` : `${pair(minutes)}:${pair(sec)}`;
}

function clampFps(fps: number, duration: number, maxFrames: number): [number, number] {
  const capped = Math.min(fps, MAX_FPS);
  return [capped, Math.min(maxFrames, Math.max(1, Math.round(capped * duration)))];
}

/** Frame budget for a full-video scan: dense when short, capped when long. */
export function autoFps(duration: number, maxFrames = 100): [number, number] {
  if (duration <= 0) return [1, 1];
  const target =
    duration <= 30
      ? Math.min(maxFrames, Math.max(12, Math.round(duration)))
      : duration <= 60
        ? Math.min(maxFrames, 40)
        : duration <= 180
          ? Math.min(maxFrames, 60)
          : duration <= 600
            ? Math.min(maxFrames, 80)
            : maxFrames;
  return clampFps(target / duration, duration, maxFrames);
}

/** Denser budget for a user-selected range. */
export function autoFpsFocus(duration: number, maxFrames = 100): [number, number] {
  if (duration <= 0) return [MAX_FPS, 2];
  const target =
    duration <= 5
      ? Math.min(maxFrames, Math.max(10, Math.round(duration * 6)))
      : duration <= 15
        ? Math.min(maxFrames, Math.max(30, Math.round(duration * 4)))
        : duration <= 30
          ? Math.min(maxFrames, 60)
          : duration <= 60
            ? Math.min(maxFrames, 80)
            : maxFrames;
  return clampFps(target / duration, duration, maxFrames);
}

/** Indices of `n` evenly spaced items out of `count`, keeping first and last. */
export function evenIndices(count: number, n: number): number[] {
  if (n >= count) return Array.from({ length: count }, (_, i) => i);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * (count - 1)) / (n - 1)));
}

/** Mean absolute difference (0-255) between two thumbnails; mismatched sizes are maximally different. */
export function frameDelta(a: Uint8Array, b: Uint8Array): number {
  if (!a.length || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

function rgbOf(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i]!;
    out[j + 1] = rgba[i + 1]!;
    out[j + 2] = rgba[i + 2]!;
  }
  return out;
}

// --- Captions -----------------------------------------------------------------------------------

const TIME = String.raw`(?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3}`;
const TIMING = new RegExp(String.raw`^\s*(${TIME})\s+-->\s+(${TIME})(?:\s+.*)?$`);

function stampSeconds(stamp: string): number {
  return stamp
    .replace(",", ".")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Parses WebVTT or SRT. Overlapping rolling-caption repeats collapse; repeated speech is kept. */
export function parseCaptions(text: string): Segment[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const raw: (Segment & { display: string })[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (/^(NOTE(\s|$)|STYLE$|REGION$)/.test(line)) {
      while (i < lines.length && lines[i] !== "") i++;
      continue;
    }
    const match = TIMING.exec(line);
    i++;
    if (!match) continue;
    const payload: string[] = [];
    while (i < lines.length && lines[i] !== "" && !TIMING.test(lines[i]!)) payload.push(lines[i++]!);
    const body = payload
      .map(part => decodeEntities(part.replace(/<[^>]*>/g, "")).trim())
      .join(" ")
      .trim();
    const start = stampSeconds(match[1]!);
    const end = stampSeconds(match[2]!);
    if (body && end >= start) raw.push({ start, end, text: body, display: line.slice(line.indexOf("-->") + 3).trim() });
  }
  const out: (Segment & { display: string })[] = [];
  for (const seg of raw) {
    const previous = out[out.length - 1];
    if (
      previous &&
      seg.start < previous.end &&
      seg.display.split(/\s+/).slice(1).join(" ") === previous.display.split(/\s+/).slice(1).join(" ") &&
      (seg.text === previous.text || seg.text.startsWith(`${previous.text} `))
    ) {
      previous.text = seg.text;
      previous.end = Math.max(previous.end, seg.end);
      continue;
    }
    out.push({ ...seg });
  }
  return out.map(({ start, end, text }) => ({ start, end, text }));
}

export function filterRange(segments: Segment[], start?: number, end?: number): Segment[] {
  if (start === undefined && end === undefined) return segments;
  const lo = start ?? Number.NEGATIVE_INFINITY;
  const hi = end ?? Number.POSITIVE_INFINITY;
  return segments.filter(seg => seg.end >= lo && seg.start <= hi);
}

export function formatTranscript(segments: Segment[]): string {
  return segments
    .map(
      s =>
        `[${String(Math.floor(s.start / 60)).padStart(2, "0")}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text}`,
    )
    .join("\n");
}

interface CaptionTrack {
  key: string;
  language: string;
  kind: "manual" | "automatic";
  provenance: "original" | "requested translation" | "unknown";
  url: string;
}

type CaptionFormats = { ext?: string; url?: string }[];

/** Chooses one caption track from yt-dlp metadata, preferring original-language evidence. */
export function selectCaption(info: YtDlpResult, language = "auto"): CaptionTrack | null {
  const clean = (value: unknown) =>
    Object.fromEntries(
      Object.entries((value ?? {}) as Record<string, CaptionFormats>).filter(
        ([key, formats]) => key !== "live_chat" && Array.isArray(formats) && formats.length,
      ),
    );
  const manual = clean(info.subtitles);
  const automatic = clean(info.automatic_captions);
  const youtube = String(info.extractor_key ?? info.extractor ?? "")
    .toLowerCase()
    .startsWith("youtube");
  const originals = Object.keys(automatic)
    .filter(key => youtube && key.endsWith("-orig"))
    .sort();
  const original = originals.length === 1 ? originals[0]!.slice(0, -5) : undefined;
  const target = language !== "auto" ? language : (original ?? (info.language as string | undefined));
  const base = (key: string) => key.replace(/-orig$/, "");
  const matches = (key: string) => {
    if (language !== "auto")
      return key === target || base(key) === target || (!language.includes("-") && base(key).split("-")[0] === target);
    return !!target && (base(key) === target || base(key).split("-")[0] === target.split("-")[0]);
  };
  const englishFirst = (a: string, b: string) =>
    Number(base(a).split("-")[0] !== "en") - Number(base(b).split("-")[0] !== "en") || a.localeCompare(b);
  const pick = (
    kind: "manual" | "automatic",
    key: string,
    tracks: Record<string, CaptionFormats>,
  ): CaptionTrack | null => {
    const formats = tracks[key]!;
    const chosen =
      formats.find(f => f.ext === "vtt" && f.url) ??
      formats.find(f => f.ext === "srt" && f.url) ??
      formats.find(f => f.url);
    if (!chosen?.url) return null;
    const lang = base(key);
    let provenance: CaptionTrack["provenance"] =
      original && lang.split("-")[0] === original.split("-")[0] ? "original" : "unknown";
    if (language !== "auto" && original && lang.split("-")[0] !== original.split("-")[0])
      provenance = "requested translation";
    return { key, language: lang, kind, provenance, url: chosen.url };
  };
  for (const [kind, tracks] of [
    ["manual", manual],
    ["automatic", automatic],
  ] as const) {
    let keys = Object.keys(tracks).sort(englishFirst);
    if (target)
      keys = keys
        .filter(matches)
        .sort(
          (a, b) =>
            Number(a !== target) - Number(b !== target) ||
            Number(a !== `${target}-orig`) - Number(b !== `${target}-orig`) ||
            a.localeCompare(b),
        );
    if (keys.length) {
      const key = kind === "automatic" && language === "auto" && originals.length ? originals[0]! : keys[0]!;
      const track = pick(kind, key, tracks);
      if (track) return track;
    }
  }
  if (language === "auto")
    for (const [kind, tracks] of [
      ["manual", manual],
      ["automatic", automatic],
    ] as const) {
      const keys = Object.keys(tracks).sort(englishFirst);
      if (keys.length) {
        const track = pick(kind, keys[0]!, tracks);
        if (track) return { ...track, provenance: "unknown" };
      }
    }
  return null;
}

// --- Sources ------------------------------------------------------------------------------------

export function isUrl(source: string): boolean {
  if (source.startsWith("-")) return false;
  try {
    const url = new URL(source);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.host;
  } catch {
    return false;
  }
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm"]);

/** Streams a direct media URL to disk within the byte limit. */
async function fetchMedia(url: string, destination: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("Download exceeds the 2 GiB limit");
  const sink = Bun.file(destination).writer();
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error("Download exceeds the 2 GiB limit");
      sink.write(chunk);
    }
  } finally {
    await sink.end();
  }
}

/** Reads .vtt, .srt or .ass captions into segments. */
export async function readCaptionFile(path: string): Promise<Segment[]> {
  const text = await Bun.file(path).text();
  if (extname(path).toLowerCase() !== ".ass") return parseCaptions(text);
  return parseSubtitle(text, "ass").map(cue => ({ start: cue.startMs / 1000, end: cue.endMs / 1000, text: cue.text }));
}

/** First existing `<stem>[.fr|.ja|.en].(vtt|srt|ass)`, in that preference order. */
async function findSidecar(stem: string): Promise<string | undefined> {
  for (const language of ["", ".fr", ".ja", ".en"])
    for (const ext of [".vtt", ".srt", ".ass"]) {
      const candidate = stem + language + ext;
      if (await Bun.file(candidate).exists()) return candidate;
    }
  return undefined;
}

interface Acquired {
  videoPath: string | null;
  info: { title?: string; uploader?: string; duration?: number };
  track: CaptionTrack | null;
  segments: Segment[];
  errors: string[];
}

async function acquire(
  options: WatchOptions,
  work: string,
  needMedia: boolean,
  needCaptions: boolean,
): Promise<Acquired> {
  const result: Acquired = { videoPath: null, info: {}, track: null, segments: [], errors: [] };
  if (!isUrl(options.source)) {
    const path = resolve(options.source);
    if (!(await Bun.file(path).exists())) throw new Error(`File not found: ${path}`);
    result.videoPath = path;
    result.info = { title: basename(path) };
    const stem = path.slice(0, path.length - extname(path).length);
    const sidecar = options.captions ? resolve(options.captions) : await findSidecar(stem);
    if (sidecar) {
      try {
        result.segments = await readCaptionFile(sidecar);
        result.track = { key: "sidecar", language: "unknown", kind: "manual", provenance: "unknown", url: sidecar };
      } catch (error) {
        result.errors.push(`Caption parsing failed: ${(error as Error).message}`);
      }
    }
    return result;
  }

  const url = new URL(options.source);
  const direct = VIDEO_EXTENSIONS.has(extname(url.pathname).toLowerCase());
  // yt-dlp supplies only metadata, caption tracks and a single progressive stream (no merge, so no FFmpeg).
  const ytOptions = {
    noPlaylist: true,
    quiet: true,
    noWarnings: true,
    ...(options.cookiesFile ? { cookieFile: options.cookiesFile } : {}),
  };
  let meta: YtDlpResult | undefined;
  if (!direct) {
    try {
      meta = await extractYtDlp(options.source, ytOptions);
      result.info = {
        title: meta.title as string,
        uploader: (meta.uploader ?? meta.channel) as string,
        duration: meta.duration as number,
      };
    } catch (error) {
      result.errors.push(`Metadata unavailable: ${(error as Error).message}`);
    }
  }
  if (needCaptions) {
    if (options.captions) {
      result.segments = await readCaptionFile(resolve(options.captions));
      result.track = { key: "file", language: "unknown", kind: "manual", provenance: "unknown", url: options.captions };
    } else if (meta) {
      result.track = selectCaption(meta, options.subLang ?? "auto");
      if (result.track) {
        try {
          const response = await fetch(result.track.url, { signal: options.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          result.segments = parseCaptions(await response.text());
        } catch (error) {
          result.errors.push(`Caption download failed: ${(error as Error).message}`);
          result.track = null;
        }
      }
    }
  }
  if (needMedia) {
    try {
      const destination = join(work, "download", `video${direct ? extname(url.pathname).toLowerCase() : ".mp4"}`);
      await mkdir(join(work, "download"), { recursive: true });
      if (direct) await fetchMedia(options.source, destination, options.signal);
      else
        await downloadYtDlp(
          options.source,
          destination,
          { ...ytOptions, format: "b[ext=mp4][height<=720]/b[height<=720]/b" },
          { signal: options.signal, maxBytes: MAX_DOWNLOAD_BYTES },
        );
      result.videoPath = destination;
    } catch (error) {
      result.errors.push(`Media unavailable: ${(error as Error).message}`);
    }
  }
  return result;
}

// --- Frames -------------------------------------------------------------------------------------

interface NativeFrame {
  resize(width: number, height?: number, options?: { fit?: "fill" | "inside" }): NativeFrame;
  jpeg(options?: { quality?: number }): NativeFrame;
  rgba(): Promise<{ data: Uint8Array }>;
  write(destination: string): Promise<number>;
}

export interface NativeVideoMetadata {
  width: number;
  height: number;
  duration: number | null;
  codec: string;
  fpsNumerator: number;
  fpsDenominator: number;
  frameCount: number;
  audioStreams: { sampleRate: number; channels: number; codec: string }[];
}

export interface NativeVideo {
  frame(seconds: number): NativeFrame;
  metadata(): Promise<NativeVideoMetadata>;
  frames(options: {
    start: number;
    end: number;
    step: number;
    maxFrames: number;
  }): Promise<{ time: number; bytes: Uint8Array }[]>;
  audio(options: { start: number; duration: number; sampleRate: number }): Promise<Uint8Array>;
}

const NativeVideoClass = (
  Bun as unknown as { Video?: { readonly available: boolean; new (input: string): NativeVideo } }
).Video;

interface NativeImage {
  resize(width: number, height?: number, options?: { fit?: "fill" | "inside" }): NativeImage;
  jpeg(options?: { quality?: number }): NativeImage;
  rgba(): Promise<{ data: Uint8Array }>;
  bytes(): Promise<Uint8Array>;
}

const NativeImageClass = (Bun as unknown as { Image: new (input: Uint8Array) => NativeImage }).Image;

interface Probe {
  time: number;
  thumb: Uint8Array;
  /** Encoded output frame, kept from the probe decode so selected frames are never decoded twice. */
  jpeg?: Uint8Array;
}

/** Uniform probe grid over [start, start + count * step). */
interface Grid {
  start: number;
  step: number;
  count: number;
}

const PNG_BUDGET_BYTES = 40 * 1024 * 1024;
const JPEG_RETAIN_BYTES = 256 * 1024 * 1024;

class FrameSource {
  readonly video: NativeVideo;
  readonly outWidth: number;
  readonly outHeight: number;
  private retained = 0;
  constructor(
    path: string,
    private readonly meta: NativeVideoMetadata,
    resolution: number,
  ) {
    if (!NativeVideoClass) throw new Error("Native Bun.Video provider unavailable in this runtime");
    this.video = new NativeVideoClass(path);
    this.outWidth = Math.min(resolution, meta.width);
    this.outHeight = Math.min(MAX_READ_DIMENSION, Math.round((this.outWidth * meta.height) / meta.width));
  }

  private async process(png: Uint8Array, keep: boolean): Promise<Pick<Probe, "thumb" | "jpeg">> {
    const [pixels, jpeg] = await Promise.all([
      new NativeImageClass(png).resize(DEDUP_THUMB, DEDUP_THUMB, { fit: "fill" }).rgba(),
      new NativeImageClass(png).resize(this.outWidth, this.outHeight, { fit: "inside" }).jpeg({ quality: 80 }).bytes(),
    ]);
    const retain = keep && this.retained + jpeg.byteLength <= JPEG_RETAIN_BYTES;
    if (retain) this.retained += jpeg.byteLength;
    return { thumb: rgbOf(pixels.data), jpeg: retain ? jpeg : undefined };
  }

  /** One decode session per chunk: far cheaper than a seek per frame (about 6x in measurement). */
  async probe(grid: Grid): Promise<Probe[]> {
    const pngBytes = Math.max(1, this.meta.width * this.meta.height * 2);
    const chunk = Math.max(1, Math.min(64, Math.floor(PNG_BUDGET_BYTES / pngBytes)));
    const out: Probe[] = [];
    for (let first = 0; first < grid.count; first += chunk) {
      const n = Math.min(chunk, grid.count - first);
      const start = grid.start + first * grid.step;
      const end = start + n * grid.step;
      let batch: { time: number; bytes: Uint8Array }[] = [];
      try {
        batch = (await this.video.frames({ start, end, step: grid.step, maxFrames: n })).filter(
          frame => frame.time < end - grid.step / 2,
        );
      } catch {
        batch = [];
      }
      if (batch.length) {
        const done = await Promise.allSettled(batch.map(frame => this.process(frame.bytes, true)));
        done.forEach((result, i) => {
          if (result.status === "fulfilled") out.push({ time: batch[i]!.time, ...result.value });
        });
        continue;
      }
      // Batch decode refused this window: seek frame by frame and skip what cannot decode.
      for (let i = 0; i < n; i++) {
        const time = start + i * grid.step;
        try {
          const pixels = await this.video.frame(time).resize(DEDUP_THUMB, DEDUP_THUMB, { fit: "fill" }).rgba();
          out.push({ time, thumb: rgbOf(pixels.data) });
        } catch {
          // Coverage gaps show in the candidate count.
        }
      }
    }
    return out;
  }

  async write(time: number, path: string, jpeg?: Uint8Array): Promise<void> {
    if (jpeg) {
      await Bun.write(path, jpeg);
      return;
    }
    await this.video
      .frame(time)
      .resize(this.outWidth, this.outHeight, { fit: "inside" })
      .jpeg({ quality: 80 })
      .write(path);
  }
}

/** Evenly spaced probe grid over [start, end), at most `limit` probes. */
function probeGrid(start: number, end: number, rate: number, limit = PROBE_LIMIT): Grid {
  const count = Math.max(1, Math.min(limit, Math.ceil((end - start) * rate)));
  return { start, step: (end - start) / count, count };
}

function sceneChanges(probes: Probe[], threshold: number): Probe[] {
  if (!probes.length) return [];
  const kept = [probes[0]!];
  for (let i = 1; i < probes.length; i++)
    if (frameDelta(probes[i]!.thumb, probes[i - 1]!.thumb) / 255 > threshold) kept.push(probes[i]!);
  return kept;
}

function dedupe(candidates: Probe[], threshold = DEDUP_THRESHOLD): { kept: Probe[]; dropped: number } {
  if (candidates.length <= 1) return { kept: candidates, dropped: 0 };
  const kept = [candidates[0]!];
  for (const candidate of candidates.slice(1))
    if (frameDelta(candidate.thumb, kept[kept.length - 1]!.thumb) > threshold) kept.push(candidate);
  return { kept, dropped: candidates.length - kept.length };
}

interface FrameSelection {
  frames: (Pick<FrameRecord, "timestampSeconds" | "reason"> & { jpeg?: Uint8Array })[];
  engine: string;
  candidateCount: number;
  dedupedCount: number;
  fallback: boolean;
}

async function selectFrames(
  source: FrameSource,
  detail: Exclude<WatchDetail, "transcript">,
  range: [number, number],
  budget: { fps: number; target: number; maxFrames: number | null },
  dedup: boolean,
): Promise<FrameSelection> {
  const [start, end] = range;
  const uniform = async (): Promise<FrameSelection> => {
    const cap = budget.maxFrames === null ? budget.target : Math.min(budget.maxFrames, budget.target);
    const rate = Math.min(budget.fps, MAX_FPS, cap / (end - start));
    const probes = await source.probe(probeGrid(start, end, rate, cap));
    const { kept, dropped } = dedup ? dedupe(probes) : { kept: probes, dropped: 0 };
    return {
      frames: kept.map(p => ({ timestampSeconds: p.time, reason: "uniform" as const, jpeg: p.jpeg })),
      engine: "uniform",
      candidateCount: probes.length,
      dedupedCount: dropped,
      fallback: true,
    };
  };
  // Scene and sampled-keyframe detection both walk the range at a bounded probe rate.
  const probeRate = detail === "efficient" ? 1 : MAX_FPS;
  const probes = await source.probe(probeGrid(start, end, probeRate));
  const candidates = detail === "efficient" ? probes : sceneChanges(probes, SCENE_THRESHOLD);
  const minimum = detail === "efficient" ? 4 : SCENE_MIN_FRAMES;
  if (candidates.length < minimum) return await uniform();
  const { kept, dropped } = dedup ? dedupe(candidates) : { kept: candidates, dropped: 0 };
  const cap = budget.maxFrames === null ? kept.length : budget.maxFrames;
  const chosen = evenIndices(kept.length, cap).map(i => kept[i]!);
  return {
    frames: chosen.map((p, i) => ({
      timestampSeconds: p.time,
      jpeg: p.jpeg,
      reason:
        detail === "efficient" ? ("sampled" as const) : i === 0 ? ("first-frame" as const) : ("scene-change" as const),
    })),
    engine: detail === "efficient" ? "sampled" : "scene",
    candidateCount: candidates.length,
    dedupedCount: dropped,
    fallback: false,
  };
}

// --- Transcription fallback ---------------------------------------------------------------------

const WHISPER_ENDPOINTS: Record<WhisperBackend, { url: string; model: string; env: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
    env: "GROQ_API_KEY",
  },
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", env: "OPENAI_API_KEY" },
};

/** Backend whose key resolves from the environment; `auto` prefers Groq. */
export function resolveWhisper(choice: WhisperBackend | "auto" | "none"): WhisperBackend | null {
  if (choice === "none") return null;
  const order: WhisperBackend[] = choice === "auto" ? ["groq", "openai"] : [choice];
  return order.find(name => process.env[WHISPER_ENDPOINTS[name].env]) ?? null;
}

async function transcribeAudio(
  video: NativeVideo,
  duration: number,
  backend: WhisperBackend,
  signal?: AbortSignal,
): Promise<{ segments: Segment[]; gaps: [number, number][] }> {
  const { url, model, env } = WHISPER_ENDPOINTS[backend];
  const key = process.env[env]!;
  const segments: Segment[] = [];
  const gaps: [number, number][] = [];
  const limit = Math.min(duration, WHISPER_MAX_SECONDS);
  for (let start = 0; start < limit; start += WHISPER_CHUNK_SECONDS) {
    const length = Math.min(WHISPER_CHUNK_SECONDS, limit - start);
    try {
      const wav = await video.audio({ start, duration: length, sampleRate: 16000 });
      const form = new FormData();
      form.set("file", new File([new Uint8Array(wav)], "audio.wav", { type: "audio/wav" }));
      form.set("model", model);
      form.set("response_format", "verbose_json");
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { segments?: { start: number; end: number; text: string }[] };
      for (const s of body.segments ?? [])
        if (s.text?.trim()) segments.push({ start: start + s.start, end: start + s.end, text: s.text.trim() });
    } catch {
      gaps.push([start, start + length]);
    }
  }
  if (gaps.length === Math.ceil(limit / WHISPER_CHUNK_SECONDS))
    throw new Error(`${backend} transcription failed for every chunk`);
  if (duration > WHISPER_MAX_SECONDS) gaps.push([WHISPER_MAX_SECONDS, duration]);
  return { segments, gaps };
}

// --- Orchestration ------------------------------------------------------------------------------

export async function watch(options: WatchOptions): Promise<WatchReport> {
  if (!NativeVideoClass?.available) throw new Error("Native Bun.Video provider unavailable in this runtime");
  const detail = options.detail ?? "balanced";
  const resolution = options.resolution ?? 512;
  if (!Number.isInteger(resolution) || resolution < 2)
    throw new Error("resolution must be an integer of at least 2 pixels");
  const maxFrames = options.maxFrames ?? frameCap(detail);
  if (options.maxFrames !== undefined && (!Number.isInteger(options.maxFrames) || options.maxFrames < 1))
    throw new Error("maxFrames must be a positive integer");
  if (options.end !== undefined && options.end <= (options.start ?? 0))
    throw new Error("end must be greater than start");
  if (options.fps !== undefined && !(options.fps > 0 && Number.isFinite(options.fps)))
    throw new Error("fps must be finite and greater than zero");
  const cues = options.timestamps ?? [];
  const backendChoice = options.whisper ?? "auto";

  const parent = options.outDir ? resolve(options.outDir) : tmpdir();
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, "watch-"));
  const errors: string[] = [];
  const warnings: string[] = [];

  const audioOnly = detail === "transcript" && cues.length === 0;
  const acquired = await acquire(options, work, !audioOnly || backendChoice !== "none", true).catch(error => {
    errors.push((error as Error).message);
    return null;
  });
  if (!acquired) throw new Error(errors[0]);
  errors.push(...acquired.errors);

  let segments = acquired.segments;
  let transcriptSource = acquired.track
    ? `captions (${acquired.track.language}, ${acquired.track.kind}, ${acquired.track.provenance})`
    : null;
  let trackAvailable = !!acquired.track && segments.length > 0;
  let source: FrameSource | null = null;
  let meta: NativeVideoMetadata | null = null;
  if (acquired.videoPath) {
    try {
      const native = new NativeVideoClass!(acquired.videoPath);
      meta = await native.metadata();
      source = new FrameSource(acquired.videoPath, meta, resolution);
    } catch (error) {
      errors.push(`Visuals/audio metadata unavailable: ${(error as Error).message}`);
      source = null;
    }
  }
  const fps = meta && meta.fpsDenominator ? meta.fpsNumerator / meta.fpsDenominator : 0;
  const duration = meta?.duration ?? (meta && fps ? meta.frameCount / fps : (acquired.info.duration ?? 0));
  if (duration > 0 && options.start !== undefined && options.start >= duration)
    throw new Error(`start ${options.start.toFixed(1)}s is past end of video (${duration.toFixed(1)}s)`);
  const effectiveStart = options.start ?? 0;
  const effectiveEnd =
    options.end !== undefined && duration > 0 ? Math.min(options.end, duration) : (options.end ?? duration);
  const effectiveDuration = Math.max(0, effectiveEnd - effectiveStart);
  const focused = options.start !== undefined || options.end !== undefined;

  const budgetCap = maxFrames ?? 100;
  let [rate, target] = focused ? autoFpsFocus(effectiveDuration, budgetCap) : autoFps(effectiveDuration, budgetCap);
  if (options.fps !== undefined) {
    rate = Math.min(options.fps, MAX_FPS);
    target = Math.max(1, Math.round(rate * effectiveDuration));
  }

  const frames: FrameRecord[] = [];
  let cueCount = 0;
  let selection: FrameSelection = { frames: [], engine: "none", candidateCount: 0, dedupedCount: 0, fallback: false };
  const frameDir = join(work, "frames");
  if (source && meta && meta.width > 0) {
    try {
      await mkdir(frameDir, { recursive: true });
      const inWindow = cues.filter(t => t >= effectiveStart && (effectiveEnd <= 0 || t <= effectiveEnd));
      const points =
        maxFrames !== null && inWindow.length > maxFrames
          ? evenIndices(inWindow.length, maxFrames).map(i => inWindow[i]!)
          : inWindow;
      const planned: FrameSelection["frames"] = points.map(t => ({
        timestampSeconds: t,
        reason: "transcript-cue",
      }));
      cueCount = planned.length;
      if (cues.length > inWindow.length)
        warnings.push(`${cues.length - inWindow.length} cue timestamp(s) dropped outside the focus range`);
      const detailBudget = maxFrames === null ? null : maxFrames - cueCount;
      if (detail !== "transcript" && detailBudget !== 0 && effectiveDuration > 0) {
        selection = await selectFrames(
          source,
          detail,
          [effectiveStart, effectiveEnd],
          { fps: rate, target, maxFrames: detailBudget },
          options.dedup !== false,
        );
        planned.push(...selection.frames);
      }
      planned.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
      const written = await Promise.all(
        planned.map(async ({ jpeg, ...frame }, index) => {
          const path = join(frameDir, `frame_${String(index).padStart(4, "0")}.jpg`);
          await source.write(frame.timestampSeconds, path, jpeg);
          return { index, path, ...frame };
        }),
      );
      frames.push(...written);
    } catch (error) {
      errors.push(`Visual extraction unavailable: ${(error as Error).message}`);
    }
  } else if (
    acquired.videoPath &&
    !errors.some(e => e.startsWith("Visuals")) &&
    (detail !== "transcript" || cues.length)
  ) {
    errors.push("No video stream; visual evidence is unavailable.");
  }

  let transcriptState = "missing";
  let gaps: [number, number][] = [];
  const hasAudio = !!meta && meta.audioStreams.length > 0;
  const backend = resolveWhisper(backendChoice);
  if (!trackAvailable && backendChoice === "none") transcriptState = "fallback disabled; no captions available";
  else if (!trackAvailable && source && hasAudio) {
    if (backend) {
      try {
        const result = await transcribeAudio(source.video, duration, backend, options.signal);
        segments = result.segments;
        gaps = result.gaps;
        trackAvailable = true;
        transcriptSource = `whisper (${backend})`;
        transcriptState = segments.length ? "available" : "no speech";
      } catch (error) {
        transcriptState = "failed";
        errors.push(`Transcription failed: ${(error as Error).message}`);
      }
    } else
      transcriptState = `unavailable: no API key for ${backendChoice === "auto" ? "groq or openai" : backendChoice}`;
  } else if (!trackAvailable && source && !hasAudio) transcriptState = "no audio stream";

  const transcript = focused ? filterRange(segments, options.start, effectiveEnd || undefined) : segments;
  if (trackAvailable)
    transcriptState = transcript.length
      ? "available"
      : focused && segments.length
        ? "no speech in selected range"
        : "no speech";
  for (const [from, to] of gaps) warnings.push(`Transcript missing ${formatTime(from)} → ${formatTime(to)}`);
  if (detail === "token-burner" && frames.length > 250)
    warnings.push(`token-burner selected ${frames.length} frames; image token cost may be large`);
  if (!focused && duration > 600 && detail !== "transcript" && detail !== "token-burner")
    warnings.push(
      `${Math.floor(duration / 60)}-minute video: ${detail} frame coverage is sparse; use --start/--end or token-burner`,
    );

  return {
    source: options.source,
    workDir: work,
    localMedia: acquired.videoPath,
    title: acquired.info.title,
    uploader: acquired.info.uploader,
    durationSeconds: duration,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    codec: meta?.codec ?? null,
    detail,
    focus: focused ? { start: effectiveStart, end: effectiveEnd } : null,
    frames,
    frameEngine: selection.engine,
    candidateCount: selection.candidateCount,
    dedupedCount: selection.dedupedCount,
    cueFrames: cueCount,
    transcript,
    transcriptSource,
    transcriptState,
    errors,
    warnings,
  };
}

/** The markdown report an agent reads: frame paths to view, then the timestamped transcript. */
export function renderReport(report: WatchReport): string {
  const out: string[] = ["# watch: video report", ""];
  out.push(`- **Source:** ${report.source}`);
  if (report.localMedia) out.push(`- **Local media:** \`${report.localMedia}\``);
  if (report.errors.length)
    out.push(`- **Result:** ${report.frames.length || report.transcript.length ? "partial" : "unavailable"} evidence`);
  if (report.title) out.push(`- **Title:** ${report.title}`);
  if (report.uploader) out.push(`- **Uploader:** ${report.uploader}`);
  out.push(`- **Duration:** ${formatTime(report.durationSeconds)} (${report.durationSeconds.toFixed(1)}s)`);
  if (report.focus) out.push(`- **Focus range:** ${formatTime(report.focus.start)} → ${formatTime(report.focus.end)}`);
  if (report.width && report.height)
    out.push(`- **Resolution:** ${report.width}x${report.height} (${report.codec ?? "unknown codec"})`);
  out.push(`- **Detail:** ${report.detail}`);
  if (report.detail !== "transcript") {
    const note = report.dedupedCount ? `, ${report.dedupedCount} near-duplicates dropped` : "";
    out.push(
      `- **Frames:** ${report.frames.length - report.cueFrames} selected from ${report.candidateCount} candidates (${report.frameEngine}${note})`,
    );
  }
  if (report.cueFrames) out.push(`- **Cue frames:** ${report.cueFrames} at transcript-flagged timestamps`);
  out.push(
    report.transcript.length
      ? `- **Transcript:** ${report.transcript.length} segments (via ${report.transcriptSource ?? "captions"})`
      : `- **Transcript:** ${report.transcriptState}`,
  );
  for (const warning of report.warnings) out.push("", `> **Warning:** ${warning}`);
  out.push("", "## Frames", "");
  if (report.frames.length) {
    out.push(
      "**Read each frame path below to view the image.** Frames are chronological; `t=MM:SS` is the source time requested (the frame decoded is the one at or just before it).",
      "",
    );
    for (const f of report.frames)
      out.push(`- \`${f.path}\` (t=${formatTime(f.timestampSeconds)}, reason=${f.reason})`);
  } else out.push("_No frames extracted._");
  out.push("", "## Transcript", "");
  if (report.transcript.length)
    out.push(
      `_Source: ${report.transcriptSource ?? "captions"}._`,
      "",
      "```",
      formatTranscript(report.transcript),
      "```",
    );
  else out.push(`_${report.transcriptState[0]!.toUpperCase()}${report.transcriptState.slice(1)}._`);
  if (report.errors.length) out.push("", "## Unavailable evidence", ...report.errors.map(e => `- ${e}`));
  out.push("", "---", `_Work dir: \`${report.workDir}\` — delete when done._`);
  return out.join("\n");
}

export async function cleanWatch(report: Pick<WatchReport, "workDir">): Promise<void> {
  await rm(report.workDir, { recursive: true, force: true });
}
