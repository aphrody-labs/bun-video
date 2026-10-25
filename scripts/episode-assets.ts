import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { compareRGBAFrames } from "../src/pixel-verify";

export interface EpisodeOptions {
  signal?: AbortSignal;
  frameLimit?: number;
  format?: "png" | "webp";
  audioLimitSeconds?: number;
}
interface EpisodeWorkManifest {
  source: { bytes: number; sha256: string; file: string };
  width: number;
  height: number;
  frameCount: number;
  durationSeconds: number;
  fps: { numerator: number; denominator: number };
  frames?: { status: string; directory: string; pattern: string; count: number; format: string };
  compression?: { file: string; bytes: number; codec: string; lossless: boolean; verified: boolean };
  highlights?: {
    id: string;
    title: string;
    start: number;
    duration: number;
    file?: string;
    bytes?: number;
    paletteLimited?: boolean;
  }[];
}
const packageRoot = resolve(import.meta.dir, "..");
const batchBudget = 64 * 1024 * 1024;
function nativeVideo() {
  if (typeof Bun.Video !== "function" || !Bun.Video.available || typeof Bun.Image.prototype.rgba !== "function")
    throw new Error("A qualified Aphrody runtime with native Bun.Video and Bun.Image.rgba is required; use bun bd");
}
export function rational(value: string) {
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator! < 1 || denominator! < 1)
    throw new TypeError("A positive rational frame rate is required");
  return { numerator: numerator!, denominator: denominator! };
}
export function frameFile(index: number, extension = "png") {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999999 || !["png", "webp"].includes(extension))
    throw new RangeError("Invalid frame index or lossless format");
  return `frame-${String(index).padStart(6, "0")}.${extension}`;
}
export function frameBatchSize(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new RangeError("Invalid source dimensions");
  const worstPNG = width * height * 4 + height + 65536;
  if (worstPNG > batchBudget) throw new RangeError("A source-resolution frame exceeds the 64 MiB batch budget");
  return Math.max(1, Math.min(8, Math.floor(batchBudget / worstPNG)));
}
export async function hashEpisodeFile(path: string) {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
function check(options: EpisodeOptions) {
  options.signal?.throwIfAborted();
}
async function manifest(root: string): Promise<EpisodeWorkManifest> {
  return Bun.file(join(root, "manifest.json")).json();
}
async function update(root: string, fields: Record<string, unknown>) {
  const path = join(root, "manifest.json");
  const value = (await Bun.file(path).exists()) ? await Bun.file(path).json() : {};
  await Bun.write(`${path}.tmp`, `${JSON.stringify({ ...value, ...fields }, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
function validateMetadata(value: Bun.Video.Metadata) {
  rational(`${value.fpsNumerator}/${value.fpsDenominator}`);
  frameBatchSize(value.width, value.height);
  if (
    !Number.isSafeInteger(value.frameCount) ||
    value.frameCount < 1 ||
    value.frameCount > 999999 ||
    !Number.isFinite(value.duration) ||
    value.duration! <= 0
  )
    throw new Error("Native video metadata lacks a complete bounded source timeline");
}
export function compareEpisodeMetadata(reference: Bun.Video.Metadata, candidate: Bun.Video.Metadata) {
  validateMetadata(reference);
  validateMetadata(candidate);
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height ||
    reference.frameCount !== candidate.frameCount ||
    reference.fpsNumerator * candidate.fpsDenominator !== candidate.fpsNumerator * reference.fpsDenominator
  )
    throw new Error("Native source and candidate differ in dimensions, frame count or rational FPS");
  if (Math.abs(reference.duration! - candidate.duration!) > 0.001)
    throw new Error("Native source and candidate durations differ by more than 1 ms");
  if (
    reference.audioStreams.length !== candidate.audioStreams.length ||
    reference.audioStreams.some((audio, index) => {
      const other = candidate.audioStreams[index]!;
      return audio.sampleRate !== other.sampleRate || audio.channels !== other.channels || audio.codec !== other.codec;
    })
  )
    throw new Error("Native source and candidate audio streams differ");
}
export async function* episodeFrameBatches(path: string, metadata: Bun.Video.Metadata, options: EpisodeOptions = {}) {
  nativeVideo();
  validateMetadata(metadata);
  const limit = options.frameLimit ?? metadata.frameCount;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > metadata.frameCount)
    throw new RangeError("Invalid explicit frame verification/extraction limit");
  const step = metadata.fpsDenominator / metadata.fpsNumerator;
  const batch = frameBatchSize(metadata.width, metadata.height);
  const video = new Bun.Video(path, { maxPixels: metadata.width * metadata.height });
  for (let start = 0; start < limit; start += batch) {
    check(options);
    const count = Math.min(batch, limit - start);
    const frames = await video.frames({
      start: start * step,
      end: Math.min((start + count) * step, metadata.duration!),
      step,
      maxFrames: count,
    });
    if (frames.length !== count || frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0) > batchBudget)
      throw new Error("Native frame batch count or encoded-byte budget differs from the source");
    for (const [offset, frame] of frames.entries())
      if (Math.abs(frame.time - (start + offset) * step) > step / 4)
        throw new Error("Native source is not a consecutive constant-FPS presentation timeline");
    yield { start, frames };
  }
}
export async function analyzeEpisode(root: string, options: EpisodeOptions = {}) {
  nativeVideo();
  check(options);
  const source = join(root, "source.mp4");
  const metadata = await new Bun.Video(source).metadata();
  validateMetadata(metadata);
  const fps = { numerator: metadata.fpsNumerator, denominator: metadata.fpsDenominator };
  const previous = (await Bun.file(join(root, "manifest.json")).exists())
    ? await Bun.file(join(root, "manifest.json")).json()
    : {};
  await update(root, {
    schemaVersion: 1,
    id: previous.id ?? basename(root),
    title: previous.title ?? "Épisode vidéo",
    source: { file: "source.mp4", bytes: metadata.fileBytes, sha256: await hashEpisodeFile(source) },
    durationSeconds: metadata.duration,
    fps,
    width: metadata.width,
    height: metadata.height,
    frameCount: metadata.frameCount,
    video: {
      codec: metadata.codec,
      container: metadata.container,
      pixelFormat: "rgba8-decoded",
      width: metadata.width,
      height: metadata.height,
      fps: { num: fps.numerator, den: fps.denominator },
      frameCount: metadata.frameCount,
      durationSeconds: metadata.duration,
    },
    audio: metadata.audioStreams[0] ? { ...metadata.audioStreams[0], language: previous.audio?.language } : null,
    audioStreams: metadata.audioStreams,
    chapters: previous.chapters ?? [],
    analysis: {
      owner: "Bun.Video / FilmCraft pure Rust",
      audioStreams: metadata.audioStreams.length,
      chapterScope: "existing declared chapters; native metadata does not expose chapters",
    },
  });
  await Bun.write(join(root, "probe.json"), JSON.stringify(metadata, null, 2));
  console.log(
    JSON.stringify({ stage: "analysis", frameCount: metadata.frameCount, fps, sourceBytes: metadata.fileBytes }),
  );
}
export async function storyboardEpisode(root: string, options: EpisodeOptions = {}) {
  nativeVideo();
  const info = await manifest(root);
  await mkdir(join(root, "storyboard"), { recursive: true });
  const storyboard = [];
  for (let time = 0; time < info.durationSeconds; time += 30) {
    check(options);
    const file = `storyboard/frame-${String(time).padStart(4, "0")}.jpg`;
    await new Bun.Video(join(root, info.source.file))
      .frame(time)
      .resize(480, undefined, { fit: "inside" })
      .jpeg({ quality: 88 })
      .write(join(root, file));
    storyboard.push({ time, file });
  }
  await update(root, { storyboard });
  await Bun.write(join(root, "poster.jpg"), Bun.file(join(root, storyboard[Math.floor(storyboard.length / 2)]!.file)));
}
export async function extractEpisode(root: string, options: EpisodeOptions = {}) {
  nativeVideo();
  const info = await manifest(root),
    source = join(root, info.source.file),
    folder = join(root, "frames");
  const metadata = await new Bun.Video(source).metadata();
  const format = options.format ?? "png";
  const limit = options.frameLimit ?? metadata.frameCount;
  await mkdir(folder, { recursive: true });
  if ((await readdir(folder)).some(file => /^frame-\d+\.(png|webp)$/.test(file)))
    throw new Error("Extraction destination already contains frames; existing qualified assets are preserved");
  const base = {
    directory: "frames",
    pattern: `frame-%06d.${format}`,
    startNumber: 1,
    expectedCount: metadata.frameCount,
    format,
    lossless: true,
    pixelFormat: "rgba8",
    owner: "Bun.Video.frames + Bun.Image",
  };
  await update(root, { frames: { ...base, count: 0, status: "extracting" } });
  let count = 0,
    bytes = 0;
  for await (const batch of episodeFrameBatches(source, metadata, options)) {
    for (const frame of batch.frames) {
      check(options);
      const file = join(folder, frameFile(++count, format));
      bytes +=
        format === "png"
          ? await Bun.write(file, frame.bytes)
          : await new Bun.Image(frame.bytes).webp({ lossless: true }).write(file);
    }
    await update(root, { frames: { ...base, count, bytes, status: "extracting" } });
  }
  if (count !== limit) throw new Error("Extracted sequence differs from the selected source frame scope");
  await update(root, {
    frames: {
      ...base,
      count,
      bytes,
      status: count === metadata.frameCount ? "complete" : "partial",
      scope: "native decoded RGBA pixels at original dimensions",
    },
  });
}
export async function compressEpisode(root: string, options: EpisodeOptions = {}) {
  nativeVideo();
  check(options);
  const info = await manifest(root),
    file = "compression/episode.mp4";
  await mkdir(join(root, "compression"), { recursive: true });
  const bytes = await new Bun.Video(join(root, info.source.file)).remux(join(root, file));
  await update(root, {
    compression: {
      file,
      bytes,
      codec: "original-encoded-access-units",
      lossless: true,
      verified: false,
      sourceBytes: info.source.bytes,
      savedBytes: info.source.bytes - bytes,
      savedPercent: 100 * (1 - bytes / info.source.bytes),
      method: "Bun.Video.remux / FilmCraft MP4; no re-encoding",
      optimalityScope: "native MP4 access-unit preservation; no unsupported codec benchmark claimed",
    },
  });
}
export async function gifsEpisode(root: string, options: EpisodeOptions = {}) {
  nativeVideo();
  const info = await manifest(root),
    highlights = info.highlights ?? [];
  if (!highlights.length) throw new Error("Select visually reviewed highlights in the manifest before GIF generation");
  await mkdir(join(root, "gifs"), { recursive: true });
  for (const highlight of highlights) {
    check(options);
    if (
      !/^[a-z0-9-]+$/.test(highlight.id) ||
      !Number.isFinite(highlight.start) ||
      highlight.start < 0 ||
      !Number.isFinite(highlight.duration) ||
      highlight.duration <= 0 ||
      highlight.duration > 5 ||
      highlight.start + highlight.duration > info.durationSeconds
    )
      throw new Error("Native highlights require a reviewed window within the source, at most five seconds");
    highlight.file = `gifs/${highlight.id}.gif`;
    if (await Bun.file(join(root, highlight.file)).exists())
      throw new Error("Existing GIF is preserved; choose a new reviewed identifier");
    highlight.bytes = await Bun.write(
      join(root, highlight.file),
      await new Bun.Video(join(root, info.source.file)).gif({
        start: highlight.start,
        duration: highlight.duration,
        fps: 12,
        width: 640,
      }),
    );
    highlight.paletteLimited = true;
  }
  await update(root, { highlights });
}
export async function verifyNativeVideos(source: string, candidate: string, options: EpisodeOptions = {}) {
  nativeVideo();
  check(options);
  const reference = await new Bun.Video(source).metadata(),
    actual = await new Bun.Video(candidate).metadata();
  compareEpisodeMetadata(reference, actual);
  const candidateVideo = new Bun.Video(candidate, { maxPixels: actual.width * actual.height });
  const differingFrameNumbers: number[] = [],
    referenceDigest = new Bun.CryptoHasher("sha256"),
    candidateDigest = new Bun.CryptoHasher("sha256");
  let checkedFrames = 0;
  for await (const batch of episodeFrameBatches(source, reference, options)) {
    check(options);
    const step = reference.fpsDenominator / reference.fpsNumerator;
    const frames = await candidateVideo.frames({
      start: batch.start * step,
      end: Math.min((batch.start + batch.frames.length) * step, actual.duration!),
      step,
      maxFrames: batch.frames.length,
    });
    if (frames.length !== batch.frames.length) throw new Error("Candidate returned an incomplete frame batch");
    for (let offset = 0; offset < frames.length; offset++) {
      check(options);
      const a = await new Bun.Image(batch.frames[offset]!.bytes, {
          maxPixels: reference.width * reference.height,
        }).rgba(),
        b = await new Bun.Image(frames[offset]!.bytes, { maxPixels: actual.width * actual.height }).rgba();
      if (a.width !== reference.width || a.height !== reference.height || b.width !== a.width || b.height !== a.height)
        throw new Error("Decoded reference/candidate frame dimensions differ");
      const result = compareRGBAFrames(a.data, b.data, { width: a.width, height: a.height });
      referenceDigest.update(a.data);
      candidateDigest.update(b.data);
      if (!result.exact || Math.abs(batch.frames[offset]!.time - frames[offset]!.time) > 0.001)
        differingFrameNumbers.push(batch.start + offset + 1);
      checkedFrames++;
    }
    console.log(
      JSON.stringify({ stage: "native-rgba-verification", checkedFrames, expectedFrames: reference.frameCount }),
    );
  }
  const audio = [];
  const audioDuration = options.audioLimitSeconds ?? reference.duration!;
  if (!Number.isFinite(audioDuration) || audioDuration <= 0 || audioDuration > reference.duration!)
    throw new RangeError("Invalid explicit audio verification scope");
  for (const [stream, info] of reference.audioStreams.entries()) {
    const a = new Bun.CryptoHasher("sha256"),
      b = new Bun.CryptoHasher("sha256");
    let windows = 0;
    for (let start = 0; start < audioDuration; start += 20) {
      check(options);
      const duration = Math.min(20, audioDuration - start);
      const referenceWav = await new Bun.Video(source).audio({ start, duration, stream, sampleRate: info.sampleRate });
      const candidateWav = await new Bun.Video(candidate).audio({
        start,
        duration,
        stream,
        sampleRate: info.sampleRate,
      });
      a.update(referenceWav);
      b.update(candidateWav);
      windows++;
    }
    const referenceSha256 = a.digest("hex"),
      candidateSha256 = b.digest("hex");
    audio.push({
      stream,
      sampleRate: info.sampleRate,
      channels: info.channels,
      windows,
      referenceSha256,
      candidateSha256,
      exact: referenceSha256 === candidateSha256,
      checkedDurationSeconds: audioDuration,
      complete: audioDuration === reference.duration!,
      scope:
        "all native PCM16 WAV windows with matching headers and source timeline; encoded packet identity is provided by native remux, not inferred from PCM",
    });
  }
  const referenceSha256 = referenceDigest.digest("hex"),
    candidateSha256 = candidateDigest.digest("hex");
  const complete =
    checkedFrames === reference.frameCount &&
    (reference.audioStreams.length === 0 || audioDuration === reference.duration!);
  return {
    owner: "Bun.Video / FilmCraft + Bun.Image.rgba",
    reference,
    actual,
    checkedFrames,
    complete,
    rgbaExact: differingFrameNumbers.length === 0 && referenceSha256 === candidateSha256,
    differingFrameNumbers,
    referenceSha256,
    candidateSha256,
    audio,
    audioExact: audio.every(stream => stream.exact),
    timelineToleranceSeconds: 0.001,
    checkedAt: new Date().toISOString(),
  };
}
export async function verifyEpisode(root: string, options: EpisodeOptions = {}) {
  const info = await manifest(root);
  if (!info.compression) throw new Error("A native MP4 remux candidate is required before verification");
  const receipt = await verifyNativeVideos(join(root, info.source.file), join(root, info.compression.file), options);
  await mkdir(join(root, "verification"), { recursive: true });
  await Bun.write(join(root, "verification/native-preservation.json"), JSON.stringify(receipt, null, 2));
  const verified = receipt.complete && receipt.rgbaExact && receipt.audioExact;
  await update(root, { verification: receipt, compression: { ...info.compression, verified } });
  if (!verified)
    throw new Error("Native preservation was incomplete or measured a frame/audio difference; inspect the receipt");
}
if (import.meta.main) {
  const args = Bun.argv.slice(2),
    operation = args[0];
  if (!operation || args.includes("--help"))
    console.log(
      "bun scripts/episode-assets.ts analyze|storyboard|extract|compress|gifs|verify [--episode-dir PATH] [--format png|webp] [--frame-limit N] [--timeout-ms 14400000]",
    );
  else {
    const option = (name: string, fallback: string) => {
      const index = args.indexOf(name);
      if (index < 0) return fallback;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
      return value;
    };
    const root = resolve(option("--episode-dir", join(packageRoot, ".local/episodes/beerus-01")));
    const timeout = Number(option("--timeout-ms", "14400000"));
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 86400000)
      throw new Error("Invalid operation deadline");
    const format = option("--format", "png");
    if (format !== "png" && format !== "webp") throw new Error("Expected PNG or lossless WebP");
    const options: EpisodeOptions = {
      signal: AbortSignal.timeout(timeout),
      format,
      ...(args.includes("--frame-limit") ? { frameLimit: Number(option("--frame-limit", "0")) } : {}),
    };
    const operations: Record<string, (root: string, options: EpisodeOptions) => Promise<void>> = {
      analyze: analyzeEpisode,
      storyboard: storyboardEpisode,
      extract: extractEpisode,
      compress: compressEpisode,
      gifs: gifsEpisode,
      verify: verifyEpisode,
    };
    if (!operations[operation]) throw new Error(`Unknown episode operation: ${operation}`);
    await operations[operation](root, options);
  }
}
