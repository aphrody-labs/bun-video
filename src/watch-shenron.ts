import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { controlCharacters, publicURL, type ShenronEpisodeVideoDelivery } from "./shenron-episode";
import { evenIndices, type Segment, type WatchReport } from "./watch";

export interface DeliveryAsset {
  /** Path relative to the delivery directory. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface DeliveryFrameAsset extends DeliveryAsset {
  width: number;
  height: number;
  timecodeSeconds: number;
}

export interface ShenronAssets {
  source: { sha256: string; bytes: number };
  video: { width: number; height: number; durationSeconds: number };
  frames: DeliveryFrameAsset[];
  subtitles: (DeliveryAsset & { language: string })[];
}

export interface ShenronAssetOptions {
  /** Directory that receives `frames/*.png` and `subtitles/*.vtt`; it is created if missing. */
  outDir: string;
  /** Delivery frames are bounded to 1..600 by the consumer intake. Default 240. */
  maxFrames?: number;
  /** Normalized language of the transcript (`fr`, `ja`, `en-US`); omit to deliver no subtitle track. */
  subtitleLanguage?: string;
}

export interface ShenronDeliveryOptions {
  /** Database wiki ID; not the episode number or a provider ID. */
  episodeId: number;
  sourceUrl: string;
  publicAssetOrigin: string;
  /** Qualified public URLs, as a map keyed by asset path or a function of that path. */
  assetUrls: Readonly<Record<string, string>> | ((path: string) => string);
}

const MAX_SOURCE_BYTES = 2 * 1024 ** 3;
const MAX_PNG_BYTES = 33 * 1024 ** 2;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

interface PngFrame {
  png(): PngFrame;
  write(destination: string): Promise<number>;
}
interface PngVideo {
  frame(seconds: number): PngFrame;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Streaming hash so a multi-gigabyte episode never sits in memory. */
async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hasher.digest("hex"), bytes };
}

function vtt(segments: Segment[]): string {
  const pad = (value: number, size: number) => String(value).padStart(size, "0");
  const stamp = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor((ms % 3600000) / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
  };
  const cues = segments.map(
    s => `${stamp(s.start)} --> ${stamp(Math.max(s.end, s.start + 0.001))}\n${s.text.replace(/-->/g, "→")}\n`,
  );
  return `WEBVTT\n\n${cues.join("\n")}`;
}

/**
 * Writes original-resolution PNG frames (at the times `watch` selected) and a VTT track, hashing each.
 * Nothing is uploaded; the caller qualifies public URLs and calls {@link createWatchDelivery}.
 */
export async function exportShenronAssets(report: WatchReport, options: ShenronAssetOptions): Promise<ShenronAssets> {
  const maximum = options.maxFrames ?? 240;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 600)
    throw new RangeError("Shenron frame delivery is bounded to 1..600 frames");
  if (!report.localMedia || !report.width || !report.height) throw new Error("The report has no decodable local video");
  if (!report.frames.length) throw new Error("The report has no frames; run watch with a frame detail level");
  if (!(report.durationSeconds >= 1 && report.durationSeconds <= 86400)) throw new Error("Invalid episode duration");
  if (options.subtitleLanguage !== undefined && !LANGUAGE.test(options.subtitleLanguage))
    throw new Error("Require a normalized external VTT language");
  const source = await hashFile(report.localMedia);
  if (source.bytes < 1 || source.bytes > MAX_SOURCE_BYTES) throw new Error("Invalid qualified source size");

  const Video = (Bun as unknown as { Video?: new (input: string) => PngVideo }).Video;
  if (!Video) throw new Error("Native Bun.Video provider unavailable in this runtime");
  const video = new Video(report.localMedia);
  const root = resolve(options.outDir);
  await mkdir(join(root, "frames"), { recursive: true });

  const times = [...new Set(report.frames.map(frame => frame.timestampSeconds))].sort((a, b) => a - b);
  const chosen = evenIndices(times.length, Math.min(maximum, times.length)).map(i => times[i]!);
  const frames: DeliveryFrameAsset[] = [];
  for (const timecodeSeconds of chosen) {
    if (timecodeSeconds >= report.durationSeconds) continue;
    const path = `frames/frame_${String(frames.length + 1).padStart(4, "0")}.png`;
    await video.frame(timecodeSeconds).png().write(join(root, path));
    const bytes = new Uint8Array(await Bun.file(join(root, path)).arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_PNG_BYTES)
      throw new Error(`Frame ${path} exceeds the PNG byte bound`);
    frames.push({
      path,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      width: report.width,
      height: report.height,
      timecodeSeconds,
    });
  }
  if (!frames.length) throw new Error("No frame lies inside the episode duration");

  const subtitles: ShenronAssets["subtitles"] = [];
  if (options.subtitleLanguage && report.transcript.length) {
    await mkdir(join(root, "subtitles"), { recursive: true });
    const path = `subtitles/${options.subtitleLanguage}.vtt`;
    const bytes = new TextEncoder().encode(vtt(report.transcript));
    await Bun.write(join(root, path), bytes);
    subtitles.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength, language: options.subtitleLanguage });
  }
  return {
    source,
    video: { width: report.width, height: report.height, durationSeconds: report.durationSeconds },
    frames,
    subtitles,
  };
}

/** Pure conversion to the Shenron intake contract; the caller owns URL qualification and publication. */
export function createWatchDelivery(
  assets: ShenronAssets,
  options: ShenronDeliveryOptions,
): ShenronEpisodeVideoDelivery {
  if (!Number.isSafeInteger(options.episodeId) || options.episodeId < 1 || options.episodeId > 2147483647)
    throw new Error("Require a qualified numeric wiki episode ID");
  const origin = publicURL(options.publicAssetOrigin + (options.publicAssetOrigin.endsWith("/") ? "" : "/"));
  if (
    origin.pathname !== "/" ||
    origin.hostname.endsWith(".r2.dev") ||
    origin.hostname.endsWith(".r2.cloudflarestorage.com")
  )
    throw new Error("Require a configured custom-domain asset origin");
  publicURL(options.sourceUrl);
  if (!/^[a-f0-9]{64}$/.test(assets.source.sha256) || assets.source.bytes < 1 || assets.source.bytes > MAX_SOURCE_BYTES)
    throw new Error("Invalid qualified source metadata");
  const urlFor = (asset: DeliveryAsset, extension: string) => {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1)
      throw new Error("Require hashed nonempty assets");
    const value =
      typeof options.assetUrls === "function" ? options.assetUrls(asset.path) : options.assetUrls[asset.path];
    if (!value) throw new Error(`No qualified public URL for ${asset.path}`);
    const url = publicURL(value);
    if (url.origin !== origin.origin || !url.pathname.toLowerCase().endsWith(extension))
      throw new Error("Public artifact URL differs from its qualified origin or format");
    return url.href;
  };
  const frames = assets.frames.map(frame => {
    if (frame.timecodeSeconds >= assets.video.durationSeconds)
      throw new Error("Frame timestamp lies outside episode duration");
    return {
      url: urlFor(frame, ".png"),
      sha256: frame.sha256,
      bytes: frame.bytes,
      width: frame.width,
      height: frame.height,
      timecodeSeconds: frame.timecodeSeconds,
      format: "png" as const,
    };
  });
  const subtitles = assets.subtitles.map(track => {
    if (controlCharacters(track.language) || !LANGUAGE.test(track.language))
      throw new Error("Require a normalized external VTT language and label");
    return { url: urlFor(track, ".vtt"), language: track.language, label: track.language, sha256: track.sha256 };
  });
  if (
    frames.length > 600 ||
    subtitles.length > 32 ||
    new Set([...frames, ...subtitles].map(asset => asset.url)).size !== frames.length + subtitles.length
  )
    throw new Error("Asset URLs must be bounded and unique");
  return {
    producer: "bun-video",
    episodeId: options.episodeId,
    source: { url: options.sourceUrl, sha256: assets.source.sha256, bytes: assets.source.bytes },
    video: assets.video,
    frames,
    ...(subtitles.length ? { subtitles } : {}),
  };
}
