import type { YtDlpOptions, YtDlpResult } from "./ytdlp";
import type { GpuRuntime, GpuReport } from "@aphrody/bun-runtime-sdk/gpu";
import type { MpvClient } from "./mpv";
import type { FFmpeg, FFmpegInput } from "./ffmpeg";
import type { WebGpuOptions } from "./webgpu";
import { materializeVideoSource, resolveVideoSource, type VideoSource } from "./source";

/** Create the native lazy frame pipeline; source ingestion does not load FFmpeg or a player. */
export async function createVideo(
  source: VideoSource,
  options: { readonly maxPixels?: number; readonly signal?: AbortSignal } = {},
): Promise<Bun.Video> {
  options.signal?.throwIfAborted();
  if (typeof Bun.Video !== "function") throw new Error("This runtime does not expose the native Bun.Video owner");
  const constructorOptions = options.maxPixels === undefined ? undefined : { maxPixels: options.maxPixels };
  if (source instanceof Blob || source instanceof ArrayBuffer) return new Bun.Video(source, constructorOptions);
  if (ArrayBuffer.isView(source))
    return new Bun.Video(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), constructorOptions);
  if (typeof source === "string" || source instanceof URL) {
    const resolved = resolveVideoSource(source);
    if (resolved.kind === "file") return new Bun.Video(resolved.path, constructorOptions);
    if (resolved.kind !== "remote" || !/^https?:\/\//i.test(resolved.url))
      throw new TypeError("Bun.Video URL ingestion requires HTTP(S); other protocols use the explicit media pipeline");
    source = new Request(resolved.url);
  }
  const resolved = await materializeVideoSource(source, options.signal, 256 * 1024 * 1024);
  options.signal?.throwIfAborted();
  if (resolved.kind !== "bytes") throw new TypeError("Bun.Video ingestion did not produce a bounded byte source");
  return new Bun.Video(resolved.data, constructorOptions);
}

export interface VideoPipelineOptions {
  readonly source: VideoSource;
  readonly ytDlp?: YtDlpOptions | false;
  readonly mpvLibraryPath?: string;
  readonly mediaDirectory?: string;
  readonly playback?: boolean;
  readonly playerOptions?: Readonly<Record<string, string>>;
  readonly webgpu?: WebGpuOptions | false;
  readonly signal?: AbortSignal;
}

export interface VideoPipelineResult {
  readonly source: unknown;
  readonly gpu: GpuReport | null;
  readonly gpuRuntime: GpuRuntime | null;
  readonly player: MpvClient | null;
  readonly ffmpeg: FFmpeg;
  readonly input: FFmpegInput;
  close(): void;
  [Symbol.dispose](): void;
}

/** Resolve a source, qualify the native GPU, and optionally attach a libmpv player. */
export async function openVideoPipeline(options: VideoPipelineOptions): Promise<VideoPipelineResult> {
  options.signal?.throwIfAborted();
  const input = await materializeVideoSource(options.source, options.signal);
  if (input.kind === "bytes" && options.playback)
    throw new TypeError("libmpv playback of memory sources requires a custom stream adapter");
  let source: typeof input | YtDlpResult = input;
  let media = input.kind === "file" ? input.path : input.kind === "remote" ? input.url : null;
  if (input.kind === "remote" && options.ytDlp && typeof options.ytDlp === "object") {
    const { runYtDlp } = await import("./ytdlp");
    source = await runYtDlp({ url: input.url, options: { quiet: true, ...options.ytDlp }, signal: options.signal });
    if (typeof source.url !== "string" || !source.url)
      throw new Error("yt-dlp did not select a directly playable media URL");
    media = source.url;
  }
  options.signal?.throwIfAborted();
  const { FFmpeg } = await import("./ffmpeg");
  options.signal?.throwIfAborted();
  const ffmpeg = FFmpeg.open(options.mediaDirectory);
  let player: MpvClient | null = null;
  let gpuRuntime: GpuRuntime | null = null;
  const close = () => {
    try {
      player?.close();
    } finally {
      try {
        gpuRuntime?.close();
      } finally {
        ffmpeg.close();
      }
    }
  };
  try {
    const nativeInput =
      input.kind === "bytes"
        ? ffmpeg.openMemory(input.data instanceof Blob ? await input.data.arrayBuffer() : input.data)
        : ffmpeg.openInput(media!);
    let gpu: VideoPipelineResult["gpu"] = null;
    if (options.webgpu !== false) {
      if (options.webgpu?.backend === "chromium")
        throw new TypeError("The native video pipeline requires the native GPU backend");
      const { GpuRuntime } = await import("@aphrody/bun-runtime-sdk/gpu");
      gpuRuntime = GpuRuntime.load(
        options.webgpu?.libraryPath === undefined ? {} : { libraryPath: options.webgpu.libraryPath },
      );
      const signals = [options.signal, options.webgpu?.signal].filter((signal): signal is AbortSignal => !!signal);
      gpu = await gpuRuntime.info(signals.length ? { signal: AbortSignal.any(signals) } : undefined);
    }
    options.signal?.throwIfAborted();
    if (options.playback || options.mpvLibraryPath) {
      const { MpvClient, mpvLibraryPath } = await import("./mpv");
      options.signal?.throwIfAborted();
      player = MpvClient.open({
        libraryPath: options.mpvLibraryPath ?? mpvLibraryPath(options.mediaDirectory),
        options: options.playerOptions,
      });
    }
    if (player && options.playback) player.command("loadfile", media!);
    return { source, gpu, gpuRuntime, player, ffmpeg, input: nativeInput, close, [Symbol.dispose]: close };
  } catch (error) {
    close();
    throw error;
  }
}
