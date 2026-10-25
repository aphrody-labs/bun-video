import { basename, extname, isAbsolute, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { normalizeXVideoUrl, XVideoSource } from "./x-source";
import type { YtDlpProgress, YtDlpResult } from "./ytdlp";

export type MediaJob =
  | {
      readonly action: "download";
      readonly url: string;
      readonly output: string;
      readonly signal?: AbortSignal;
      readonly maxBytes?: number;
      readonly maxDurationSeconds?: number;
      readonly onProgress?: (progress: YtDlpProgress) => void;
    }
  | { readonly action: "inspect"; readonly source: string; readonly signal?: AbortSignal }
  | {
      /** Timestamped frames and a transcript for an agent; see `docs/watch.md`. */
      readonly action: "watch";
      readonly source: string;
      readonly options?: Omit<import("./watch").WatchOptions, "source" | "signal">;
      readonly signal?: AbortSignal;
    }
  | {
      readonly action: "extract-frame";
      readonly input: string;
      readonly output: string;
      readonly timeSeconds: number;
      readonly width?: number;
      readonly height?: number;
      readonly signal?: AbortSignal;
    }
  | {
      readonly action: "extract-frames";
      readonly input: string;
      readonly outputDirectory: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly stepSeconds: number;
      readonly maxFrames?: number;
      readonly signal?: AbortSignal;
    }
  | {
      readonly action: "extract-audio";
      readonly input: string;
      readonly output: string;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly sampleRate?: number;
      readonly signal?: AbortSignal;
    }
  | {
      readonly action: "gif";
      readonly input: string;
      readonly output: string;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly fps?: number;
      readonly width?: number;
      readonly signal?: AbortSignal;
    }
  | { readonly action: "remux"; readonly input: string; readonly output: string; readonly signal?: AbortSignal }
  | {
      readonly action: "cut";
      readonly input: string;
      readonly output: string;
      readonly startSeconds: number;
      readonly durationSeconds: number;
      readonly signal?: AbortSignal;
    }
  | {
      readonly action: "compress";
      readonly input: string;
      readonly output: string;
      readonly quality?: number;
      readonly preset?: "ultrafast" | "fast" | "medium" | "slow" | "veryslow";
      readonly signal?: AbortSignal;
    };

function outputPath(input: string, label: string): string {
  if (!input || input.includes("\0")) throw new TypeError(`${label} path is required`);
  const path = resolve(input);
  if (!isAbsolute(path) || basename(path) === "." || extname(path) === "")
    throw new TypeError(`${label} must be an absolute media filename with an extension`);
  return path;
}

function localInput(input: string): string {
  if (!input || input.includes("\0")) throw new TypeError("Input path is required");
  const path = resolve(input);
  if (!isAbsolute(path)) throw new TypeError("Input path must be absolute");
  return path;
}

interface NativeVideoFrame {
  resize(width: number, height?: number): NativeVideoFrame;
  write(output: string): Promise<void>;
}

interface NativeVideoInstance {
  metadata(): Promise<{ readonly duration: number }>;
  frame(time: number): NativeVideoFrame;
  frames(options: {
    readonly start: number;
    readonly end: number;
    readonly step: number;
    readonly maxFrames: number;
  }): Promise<readonly { readonly time: number; readonly bytes: Uint8Array }[]>;
  audio(options: {
    readonly start: number;
    readonly duration: number;
    readonly sampleRate: number;
  }): Promise<Uint8Array>;
  gif(options: {
    readonly start: number;
    readonly duration: number;
    readonly fps: number;
    readonly width: number;
  }): Promise<Uint8Array>;
  remux(output: string): Promise<void>;
}

interface NativeVideoConstructor {
  readonly available: boolean;
  new (source: string): NativeVideoInstance;
}

function openNativeVideo(input: string): NativeVideoInstance {
  const Video = (Bun as unknown as { Video?: NativeVideoConstructor }).Video;
  if (!Video?.available) throw new Error("Native Bun.Video provider is unavailable");
  return new Video(input);
}

function validateMediaRange(start: number, duration: number, total: number, maximum: number): void {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > maximum)
    throw new RangeError(`Media range must be within 0..${maximum} seconds`);
  if (start + duration > total) throw new RangeError("Media range exceeds the source duration");
}

async function editWithFFmpeg(
  args: string[],
  signal?: AbortSignal,
): Promise<{ readonly output: string; readonly bytes: number }> {
  signal?.throwIfAborted();
  const { mediaAssets } = await import("bun-video:media-runtime");
  const child = Bun.spawn([mediaAssets.ffmpegExecutable, "-hide_banner", "-nostdin", "-n", ...args], {
    stdout: "ignore",
    stderr: "pipe",
    signal,
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) {
    const detail = stderr.split("\n").filter(Boolean).slice(-8).join("\n").slice(-2000);
    throw new Error(`FFmpeg exited with status ${status}${detail ? `: ${detail}` : ""}`);
  }
  const output = args.at(-1)!;
  const file = Bun.file(output);
  if (!(await file.exists()) || file.size === 0) throw new Error("FFmpeg did not produce a non-empty output file");
  return { output, bytes: file.size };
}

/** One typed entry point for source inspection, acquisition, timeline cuts and compression. */
export async function executeMediaJob(job: MediaJob) {
  job.signal?.throwIfAborted();
  if (job.action === "download") {
    const output = outputPath(job.output, "Output");
    const parsed = new URL(job.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("Source must use HTTP(S)");
    const controls = {
      ...(job.signal ? { signal: job.signal } : {}),
      ...(job.maxBytes !== undefined ? { maxBytes: job.maxBytes } : {}),
      ...(job.maxDurationSeconds !== undefined ? { maxDurationSeconds: job.maxDurationSeconds } : {}),
      ...(job.onProgress ? { onProgress: job.onProgress } : {}),
    };
    const xStatus = (() => {
      try {
        return normalizeXVideoUrl(parsed.href);
      } catch {
        return undefined;
      }
    })();
    let result: YtDlpResult & { readonly localPath: string };
    if (xStatus) {
      const { downloadYtDlp } = await import("./ytdlp");
      const source = new XVideoSource({
        ytdlp: { format: "bestvideo+bestaudio/best", merge_output_format: "mp4" },
        download: (url, path, options) => downloadYtDlp(url, path, options, controls),
      });
      const metadata = await source.download(xStatus.url, output);
      result = { ...metadata, localPath: output };
    } else {
      const { downloadYtDlp } = await import("./ytdlp");
      result = await downloadYtDlp(
        parsed.href,
        output,
        { no_playlist: true, format: "bestvideo+bestaudio/best", merge_output_format: "mp4" },
        controls,
      );
    }
    return {
      action: job.action,
      output: result.localPath,
      bytes: Bun.file(result.localPath).size,
      metadata: result,
    } as const;
  }

  if (job.action === "inspect") {
    let url: URL | undefined;
    try {
      url = new URL(job.source);
    } catch {}
    if (url) {
      if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new TypeError("Source URL must use HTTP(S) without credentials");
      const { extractYtDlp } = await import("./ytdlp");
      return { action: job.action, metadata: await extractYtDlp(url.href, { no_playlist: true }) } as const;
    }
    const input = localInput(job.source);
    if (!(await Bun.file(input).exists())) throw new Error("Input media file does not exist");
    const video = openNativeVideo(input);
    return { action: job.action, input, metadata: await video.metadata() } as const;
  }

  if (job.action === "watch") {
    const { watch } = await import("./watch");
    return {
      action: job.action,
      report: await watch({ ...job.options, source: job.source, signal: job.signal }),
    } as const;
  }

  const input = localInput(job.input);

  if (job.action === "extract-frames") {
    if (!(await Bun.file(input).exists()) || Bun.file(input).size === 0)
      throw new Error("Input media is missing or empty");
    const outputDirectory = resolve(job.outputDirectory);
    if (input === outputDirectory) throw new TypeError("Input and output paths must differ");
    const video = openNativeVideo(input);
    const metadata = await video.metadata();
    if (
      !Number.isFinite(job.startSeconds) ||
      job.startSeconds < 0 ||
      !Number.isFinite(job.endSeconds) ||
      job.endSeconds <= job.startSeconds ||
      job.endSeconds > metadata.duration ||
      !Number.isFinite(job.stepSeconds) ||
      job.stepSeconds <= 0
    )
      throw new RangeError("Frame range must be finite, positive, and within the source duration");
    const maxFrames = job.maxFrames ?? 64;
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 64)
      throw new RangeError("Frame batches must contain 1..64 frames");
    const frames = await video.frames({
      start: job.startSeconds,
      end: job.endSeconds,
      step: job.stepSeconds,
      maxFrames,
    });
    const totalBytes = frames.reduce((total, frame) => total + frame.bytes.byteLength, 0);
    if (totalBytes > 64 * 1024 * 1024) throw new RangeError("Frame batch exceeds 64 MiB");
    await mkdir(outputDirectory);
    const written: { readonly file: string; readonly timeSeconds: number; readonly bytes: number }[] = [];
    try {
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        const file = resolve(outputDirectory, `frame-${String(index + 1).padStart(3, "0")}.png`);
        await Bun.write(file, frame.bytes);
        written.push({ file, timeSeconds: frame.time, bytes: frame.bytes.byteLength });
      }
      await Bun.write(resolve(outputDirectory, "timeline.json"), JSON.stringify({ input, frames: written }, null, 2));
    } catch (error) {
      await rm(outputDirectory, { recursive: true, force: true });
      throw error;
    }
    return { action: job.action, outputDirectory, frames: written, totalBytes } as const;
  }

  const output = outputPath(job.output, "Output");
  if (input === output) throw new TypeError("Input and output paths must differ");
  if (!(await Bun.file(input).exists()) || Bun.file(input).size === 0)
    throw new Error("Input media is missing or empty");
  if (await Bun.file(output).exists()) throw new Error("Output already exists; choose a new path");

  if (job.action === "extract-frame") {
    if (![".jpg", ".jpeg", ".png", ".webp", ".heic", ".avif"].includes(extname(output).toLowerCase()))
      throw new TypeError("Frame output must be JPEG, PNG, WebP, HEIC or AVIF");
    if (!Number.isFinite(job.timeSeconds) || job.timeSeconds < 0)
      throw new RangeError("Frame time must be non-negative");
    if ((job.width === undefined) !== (job.height === undefined))
      throw new TypeError("Set both --width and --height to resize a frame");
    if (job.width !== undefined && (!Number.isSafeInteger(job.width) || job.width < 1 || job.width > 16_384))
      throw new RangeError("Frame width must be 1..16384");
    if (job.height !== undefined && (!Number.isSafeInteger(job.height) || job.height < 1 || job.height > 16_384))
      throw new RangeError("Frame height must be 1..16384");
    if (job.width !== undefined && job.height !== undefined && job.width * job.height > 64 * 1024 * 1024)
      throw new RangeError("Resized frames must not exceed 64 megapixels");
    const video = openNativeVideo(input);
    const metadata = await video.metadata();
    if (job.timeSeconds >= metadata.duration) throw new RangeError("Frame time exceeds the source duration");
    const frame = video.frame(job.timeSeconds);
    if (job.width !== undefined && job.height !== undefined) frame.resize(job.width, job.height);
    await frame.write(output);
    return { action: job.action, input, output, bytes: Bun.file(output).size } as const;
  }

  if (job.action === "extract-audio") {
    if (extname(output).toLowerCase() !== ".wav") throw new TypeError("Audio output must use the .wav extension");
    const sampleRate = job.sampleRate ?? 48_000;
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000)
      throw new RangeError("Audio sample rate must be 8000..192000 Hz");
    const video = openNativeVideo(input);
    const metadata = await video.metadata();
    validateMediaRange(job.startSeconds, job.durationSeconds, metadata.duration, 30);
    const bytes = await video.audio({ start: job.startSeconds, duration: job.durationSeconds, sampleRate });
    if (bytes.byteLength > 64 * 1024 * 1024) throw new RangeError("Extracted audio exceeds 64 MiB");
    await Bun.write(output, bytes);
    return { action: job.action, input, output, bytes: bytes.byteLength, sampleRate } as const;
  }

  if (job.action === "gif") {
    if (extname(output).toLowerCase() !== ".gif") throw new TypeError("GIF output must use the .gif extension");
    const fps = job.fps ?? 12;
    const width = job.width ?? 640;
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 24) throw new RangeError("GIF frame rate must be 1..24 fps");
    if (!Number.isSafeInteger(width) || width < 1 || width > 640)
      throw new RangeError("GIF width must be 1..640 pixels");
    const video = openNativeVideo(input);
    const metadata = await video.metadata();
    validateMediaRange(job.startSeconds, job.durationSeconds, metadata.duration, 5);
    const bytes = await video.gif({ start: job.startSeconds, duration: job.durationSeconds, fps, width });
    if (bytes.byteLength > 32 * 1024 * 1024) throw new RangeError("GIF exceeds 32 MiB");
    await Bun.write(output, bytes);
    return { action: job.action, input, output, bytes: bytes.byteLength, fps, width } as const;
  }

  if (job.action === "remux") {
    if (![".mp4", ".mov", ".mkv", ".webm"].includes(extname(output).toLowerCase()))
      throw new TypeError("Remux output must be MP4, MOV, MKV or WebM");
    await openNativeVideo(input).remux(output);
    return { action: job.action, input, output, bytes: Bun.file(output).size } as const;
  }

  if (job.action === "cut") {
    if (!Number.isFinite(job.startSeconds) || job.startSeconds < 0 || job.startSeconds > 86400)
      throw new RangeError("Start time must be between 0 and 86400 seconds");
    if (!Number.isFinite(job.durationSeconds) || job.durationSeconds <= 0 || job.durationSeconds > 86400)
      throw new RangeError("Cut duration must be between 0 and 86400 seconds");
    return {
      action: job.action,
      ...(await editWithFFmpeg(
        [
          "-ss",
          String(job.startSeconds),
          "-i",
          input,
          "-t",
          String(job.durationSeconds),
          "-map",
          "0:v?",
          "-map",
          "0:a?",
          "-c",
          "copy",
          output,
        ],
        job.signal,
      )),
    } as const;
  }

  const quality = job.quality ?? 23;
  if (!Number.isSafeInteger(quality) || quality < 0 || quality > 51) throw new RangeError("Quality must be 0..51");
  const preset = job.preset ?? "medium";
  const webm = extname(output).toLowerCase() === ".webm";
  const webmSpeed: Readonly<Record<typeof preset, string>> = {
    ultrafast: "8",
    fast: "6",
    medium: "4",
    slow: "2",
    veryslow: "0",
  };
  return {
    action: job.action,
    ...(await editWithFFmpeg(
      [
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        ...(webm
          ? ["-c:v", "libvpx-vp9", "-crf", String(quality), "-b:v", "0", "-cpu-used", webmSpeed[preset]]
          : ["-c:v", "libx264", "-crf", String(quality), "-preset", preset]),
        "-c:a",
        webm ? "libopus" : "aac",
        output,
      ],
      job.signal,
    )),
  } as const;
}
