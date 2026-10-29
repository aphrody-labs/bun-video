/**
 * Upstream-Bun implementation of the video owner used by this package.
 *
 * The Bun fork linked a native `Bun.Video` class (FilmCraft). Unmodified Bun has none, so this
 * module provides the same surface with documented upstream APIs only: `Bun.spawn` of the
 * caller-owned FFmpeg/FFprobe executables, `Bun.Image` for frame transforms and `node:fs`/`node:os`
 * for scratch files. On a legacy fork build that still exposes `Bun.Video`, `Video` delegates to it.
 *
 * Executables: `BUN_VIDEO_FFMPEG` / `BUN_VIDEO_FFPROBE`, else `ffmpeg` / `ffprobe` on PATH. Nothing is
 * downloaded or installed implicitly.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import "./image-compat";
import { decodePngToRgba, type RgbaPixels } from "./png-decode";

export interface VideoMetadata {
  readonly width: number;
  readonly height: number;
  readonly duration: number | null;
  readonly codec: string;
  readonly container: string;
  readonly fpsNumerator: number;
  readonly fpsDenominator: number;
  readonly frameCount: number;
  readonly fileBytes: number;
  readonly audioStreams: readonly { readonly sampleRate: number; readonly channels: number; readonly codec: string }[];
}

export interface VideoOptions {
  readonly maxPixels?: number;
  readonly autoOrient?: boolean;
}

export type VideoSourceInput = string | Uint8Array | ArrayBuffer | Blob;

interface LegacyBunVideo {
  readonly available: boolean;
  readonly decoder?: string;
  readonly backend?: string;
  new (source: VideoSourceInput, options?: VideoOptions): unknown;
}

const MAX_FRAMES = 64;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_SOURCE = 256 * 1024 * 1024;

function executable(variable: string, fallback: string): string | null {
  const configured = process.env[variable];
  if (configured) return configured;
  return Bun.which(fallback);
}

function ffmpegPath(): string {
  const path = executable("BUN_VIDEO_FFMPEG", "ffmpeg");
  if (!path) throw new Error("FFmpeg is required: set BUN_VIDEO_FFMPEG or put ffmpeg on PATH");
  return path;
}

function ffprobePath(): string {
  const path = executable("BUN_VIDEO_FFPROBE", "ffprobe");
  if (!path) throw new Error("FFprobe is required: set BUN_VIDEO_FFPROBE or put ffprobe on PATH");
  return path;
}

async function run(cmd: string[], signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${stderr.trim().split("\n").slice(-4).join(" | ")}`);
  return new Uint8Array(stdout);
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Split a concatenated PNG stream (ffmpeg image2pipe) into images by walking chunk lengths. */
export function splitPngStream(stream: Uint8Array): Uint8Array[] {
  const images: Uint8Array[] = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let offset = 0;
  while (offset + 8 <= stream.length) {
    if (PNG_SIGNATURE.some((byte, i) => stream[offset + i] !== byte)) throw new Error("Corrupt PNG stream from FFmpeg");
    const start = offset;
    offset += 8;
    for (;;) {
      if (offset + 12 > stream.length) throw new Error("Truncated PNG stream from FFmpeg");
      const length = view.getUint32(offset);
      const isEnd = stream[offset + 4] === 0x49 && stream[offset + 5] === 0x45 && stream[offset + 6] === 0x4e && stream[offset + 7] === 0x44;
      offset += 12 + length;
      if (isEnd) break;
    }
    images.push(stream.subarray(start, offset));
  }
  return images;
}

type ImageOp = readonly [method: string, args: readonly unknown[]];
const TERMINALS = new Set(["bytes", "buffer", "toBuffer", "blob", "write", "toBase64", "dataurl", "toDataURL", "placeholder"]);

/** A lazily decoded frame; chainable and mutable like Bun.Image (methods record the step and return `this`), with `extract` and `rgba` added. */
export class VideoFrame {
  readonly #decode: (crop: ImageCrop | undefined) => Promise<Uint8Array>;
  readonly #ops: ImageOp[];
  #crop: ImageCrop | undefined;
  readonly #options: VideoOptions;

  constructor(
    decode: (crop: ImageCrop | undefined) => Promise<Uint8Array>,
    options: VideoOptions = {},
    ops: ImageOp[] = [],
    crop?: ImageCrop,
  ) {
    this.#decode = decode;
    this.#options = options;
    this.#ops = ops;
    this.#crop = crop;
  }

  #with(method: string, args: readonly unknown[]): VideoFrame {
    this.#ops.push([method, args]);
    return this;
  }

  extract(region: ImageCrop): VideoFrame {
    for (const key of ["left", "top", "width", "height"] as const)
      if (!Number.isInteger(region[key]) || region[key] < 0) throw new RangeError(`extract.${key} must be a non-negative integer`);
    if (region.width < 1 || region.height < 1) throw new RangeError("extract region must not be empty");
    this.#crop = region;
    return this;
  }
  resize(width: number, height?: number, options?: Record<string, unknown>): VideoFrame {
    return this.#with("resize", height === undefined ? [width] : options === undefined ? [width, height] : [width, height, options]);
  }
  rotate(degrees: number): VideoFrame {
    return this.#with("rotate", [degrees]);
  }
  flip(): VideoFrame {
    return this.#with("flip", []);
  }
  flop(): VideoFrame {
    return this.#with("flop", []);
  }
  modulate(options: { brightness?: number; saturation?: number }): VideoFrame {
    return this.#with("modulate", [options]);
  }
  png(options?: Record<string, unknown>): VideoFrame {
    return this.#with("png", options ? [options] : []);
  }
  jpeg(options?: { quality?: number }): VideoFrame {
    return this.#with("jpeg", options ? [options] : []);
  }
  webp(options?: Record<string, unknown>): VideoFrame {
    return this.#with("webp", options ? [options] : []);
  }
  heic(options?: Record<string, unknown>): VideoFrame {
    return this.#with("heic", options ? [options] : []);
  }
  avif(options?: Record<string, unknown>): VideoFrame {
    return this.#with("avif", options ? [options] : []);
  }

  async #image(): Promise<InstanceType<typeof Bun.Image>> {
    const decoded = await this.#decode(this.#crop);
    let image: any = new Bun.Image(decoded, { maxPixels: this.#options.maxPixels, autoOrient: false });
    for (const [method, args] of this.#ops) image = image[method](...args);
    return image;
  }
  async #terminal(method: string, args: readonly unknown[]): Promise<any> {
    if (!TERMINALS.has(method)) throw new Error(`Unknown terminal ${method}`);
    return ((await this.#image()) as any)[method](...args);
  }

  bytes(): Promise<Uint8Array> {
    return this.#terminal("bytes", []);
  }
  buffer(): Promise<Buffer> {
    return this.#terminal("buffer", []);
  }
  toBuffer(): Promise<Buffer> {
    return this.#terminal("toBuffer", []);
  }
  blob(): Promise<Blob> {
    return this.#terminal("blob", []);
  }
  write(destination: Parameters<typeof Bun.write>[0]): Promise<number> {
    return this.#terminal("write", [destination]);
  }
  toBase64(): Promise<string> {
    return this.#terminal("toBase64", []);
  }
  dataurl(): Promise<string> {
    return this.#terminal("dataurl", []);
  }
  toDataURL(): Promise<string> {
    return this.#terminal("toDataURL", []);
  }
  placeholder(): Promise<string> {
    return this.#terminal("placeholder", []);
  }
  async metadata(): Promise<{ width: number; height: number; format: string }> {
    return (await this.#image()).metadata() as Promise<{ width: number; height: number; format: string }>;
  }
  /** Raw RGBA8 pixels: Bun.Image has no such terminal, so the PNG encode is decoded in-process. */
  async rgba(): Promise<RgbaPixels> {
    const image: any = await this.#image();
    return decodePngToRgba(await image.png().bytes(), this.#options.maxPixels);
  }
}

export interface ImageCrop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

class SpawnVideo {
  readonly #source: VideoSourceInput;
  readonly #options: VideoOptions;
  #scratch: string | undefined;
  #path: string | undefined;
  #metadata: Promise<VideoMetadata> | undefined;
  /** Dimensions of the last transformed frame; -1 until a frame terminal ran (mirrors Bun.Image). */
  width = -1;
  height = -1;

  constructor(source: VideoSourceInput, options: VideoOptions = {}) {
    if (typeof source === "string" && !isAbsolute(resolve(source))) throw new TypeError("Invalid video path");
    this.#source = source;
    this.#options = options;
  }

  static get available(): boolean {
    return executable("BUN_VIDEO_FFMPEG", "ffmpeg") !== null && executable("BUN_VIDEO_FFPROBE", "ffprobe") !== null;
  }
  static readonly decoder = "ffmpeg-spawn";
  static get backend(): string {
    return String((Bun.Image as unknown as { backend?: string }).backend ?? "bun-image");
  }

  /** Remove the scratch copy of an in-memory source. Path sources own nothing. */
  close(): void {
    if (this.#scratch) rmSync(this.#scratch, { recursive: true, force: true });
    this.#scratch = undefined;
  }
  [Symbol.dispose](): void {
    this.close();
  }

  async #file(): Promise<string> {
    if (this.#path) return this.#path;
    const source = this.#source;
    if (typeof source === "string") return (this.#path = resolve(source));
    const bytes =
      source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    if (bytes.byteLength > MAX_MEMORY_SOURCE) throw new RangeError("In-memory video input is limited to 256 MiB");
    this.#scratch = mkdtempSync(join(tmpdir(), "bun-video-src-"));
    this.#path = join(this.#scratch, "input");
    writeFileSync(this.#path, bytes);
    return this.#path;
  }

  metadata(): Promise<VideoMetadata> {
    return (this.#metadata ??= this.#probe());
  }

  async #probe(): Promise<VideoMetadata> {
    const path = await this.#file();
    const out = await run([ffprobePath(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    const info = JSON.parse(new TextDecoder().decode(out)) as {
      format?: { format_name?: string; duration?: string; size?: string };
      streams?: Array<Record<string, any>>;
    };
    const video = info.streams?.find(s => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
    if (!video) throw new Error("No video stream");
    const [num, den] = String(video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate ?? "0/1")
      .split("/")
      .map(Number);
    const duration = Number(video.duration ?? info.format?.duration);
    const fpsNumerator = num || 0;
    const fpsDenominator = den || 1;
    const nb = Number(video.nb_frames);
    const width = Number(video.width);
    const height = Number(video.height);
    if (this.#options.maxPixels !== undefined && width * height > this.#options.maxPixels)
      throw new RangeError("Video exceeds maxPixels");
    return {
      width,
      height,
      duration: Number.isFinite(duration) ? duration : null,
      codec: String(video.codec_name),
      container: String(info.format?.format_name ?? "").split(",")[0]!,
      fpsNumerator,
      fpsDenominator,
      frameCount: Number.isFinite(nb) && nb > 0 ? nb : Math.round((Number.isFinite(duration) ? duration : 0) * (fpsNumerator / fpsDenominator)),
      fileBytes: Number(info.format?.size ?? 0),
      audioStreams: (info.streams ?? [])
        .filter(s => s.codec_type === "audio")
        .map(s => ({ sampleRate: Number(s.sample_rate), channels: Number(s.channels), codec: String(s.codec_name) })),
    };
  }

  /** Select the frame at or immediately before `seconds`. */
  frame(seconds: number): VideoFrame {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Frame time must be a non-negative number");
    return new VideoFrame(crop => this.#decodeAt(seconds, crop), this.#options);
  }

  async #decodeAt(seconds: number, crop?: ImageCrop): Promise<Uint8Array> {
    const path = await this.#file();
    await this.metadata();
    const filters = crop ? ["-vf", `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top}`] : [];
    const png = await run([
      ffmpegPath(), "-v", "error", "-nostdin", "-ss", String(seconds), "-i", path,
      "-frames:v", "1", "-an", ...filters, "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ]);
    if (png.length === 0) throw new Error("No frame at the requested time");
    return png;
  }

  /** Bounded batch of source-resolution PNGs; `end` is exclusive. */
  async frames(options: { start: number; end: number; step: number; maxFrames: number }): Promise<{ time: number; bytes: Uint8Array }[]> {
    const { start, end, step, maxFrames } = options;
    if (![start, end, step].every(Number.isFinite) || start < 0 || end <= start || step <= 0) throw new RangeError("Invalid frame range");
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_FRAMES) throw new RangeError(`maxFrames must be 1..${MAX_FRAMES}`);
    const count = Math.min(maxFrames, Math.ceil((end - start) / step));
    await this.metadata();
    // One seek per frame: identical to frame(t), so a batch frame never differs from a single one
    // (FFmpeg's fps filter rounds to different source frames than `-ss t`). Four decoders at a time.
    const times = Array.from({ length: count }, (_, i) => start + i * step);
    const out: { time: number; bytes: Uint8Array }[] = new Array(count);
    let next = 0;
    let total = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const bytes = await this.#decodeAt(times[i]!);
        total += bytes.length;
        if (total > MAX_BATCH_BYTES) throw new RangeError("Frame batch exceeds 64 MiB of encoded output");
        out[i] = { time: times[i]!, bytes };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, count) }, worker));
    return out;
  }

  async #toFile(extension: string, args: string[]): Promise<Uint8Array> {
    const path = await this.#file();
    const dir = mkdtempSync(join(tmpdir(), "bun-video-out-"));
    try {
      const output = join(dir, `out.${extension}`);
      await run([ffmpegPath(), "-v", "error", "-nostdin", "-y", ...args.map(a => (a === "{in}" ? path : a === "{out}" ? output : a))]);
      return new Uint8Array(readFileSync(output));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** PCM WAV of a time range. */
  audio(options: { start: number; duration: number; sampleRate: number }): Promise<Uint8Array> {
    const { start, duration, sampleRate } = options;
    if (!(start >= 0) || !(duration > 0) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
      throw new RangeError("Invalid audio range");
    return this.#toFile("wav", ["-ss", String(start), "-t", String(duration), "-i", "{in}", "-vn", "-ar", String(sampleRate), "-c:a", "pcm_s16le", "{out}"]);
  }

  /** Palette-optimised GIF of a time range. */
  gif(options: { start: number; duration: number; fps: number; width: number }): Promise<Uint8Array> {
    const { start, duration, fps, width } = options;
    if (!(start >= 0) || !(duration > 0) || !(fps > 0) || !Number.isInteger(width) || width < 1) throw new RangeError("Invalid GIF range");
    return this.#toFile("gif", [
      "-ss", String(start), "-t", String(duration), "-i", "{in}", "-an",
      "-vf", `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, "{out}",
    ]);
  }

  /** Stream-copy into the container implied by the (new) output path. */
  async remux(output: string): Promise<void> {
    const target = resolve(output);
    if (existsSync(target)) throw new Error("Output already exists");
    const path = await this.#file();
    await run([ffmpegPath(), "-v", "error", "-nostdin", "-n", "-i", path, "-map", "0", "-c", "copy", target]);
  }

  /** Stream-copy into a VOD HLS playlist (`index.m3u8` + `.ts` segments) in a new directory. */
  async hls(directory: string, options: { segmentSeconds?: number } = {}): Promise<{ playlist: string; segments: string[] }> {
    const dir = resolve(directory);
    if (existsSync(dir)) throw new Error("Output directory already exists");
    const seconds = options.segmentSeconds ?? 6;
    if (!(seconds > 0)) throw new RangeError("segmentSeconds must be positive");
    const path = await this.#file();
    mkdirSync(dir, { recursive: true });
    await run([
      ffmpegPath(), "-v", "error", "-nostdin", "-n", "-i", path, "-c", "copy", "-f", "hls",
      "-hls_time", String(seconds), "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "segment-%05d.ts"), join(dir, "index.m3u8"),
    ]);
    return { playlist: join(dir, "index.m3u8"), segments: readdirSync(dir).filter(f => f.endsWith(".ts")).sort().map(f => join(dir, f)) };
  }
}

const legacy = (Bun as unknown as { Video?: LegacyBunVideo }).Video;

/**
 * The video owner. Prefers a legacy fork `Bun.Video` when present, otherwise the spawn-based
 * implementation above. Check `Video.available` before use.
 */
export const Video = (legacy ?? SpawnVideo) as typeof SpawnVideo;
export type Video = SpawnVideo;
export { SpawnVideo };
