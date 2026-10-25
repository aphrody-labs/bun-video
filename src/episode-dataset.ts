import { isAbsolute, join, relative, resolve } from "node:path";
import { parseSubtitle, renderSubtitle, type SubtitleCue } from "../scripts/episode-subtitles";
import type { FrameAnalysisOptions, FrameAnalysis } from "./frame-analysis";

export interface FrameMetrics {
  width: number;
  height: number;
  meanLuminance: number;
  luminanceVariance: number;
  laplacianVariance: number;
  edgeEnergy: number;
  score: number;
  lowDetail: boolean;
  captionRegionExcluded: true;
  computation: "WGSL";
  backend: FrameAnalysis["backend"];
  adapter: FrameAnalysis["adapter"];
  samples: number;
  elapsedMs: number;
}

interface CharacterProof {
  timeSeconds: number;
  file: string;
  note: string;
}
interface CharacterMetadata {
  id: string;
  name: string;
  evidence: CharacterProof[];
}
interface CharacterContext {
  id: string;
  nameFr: string;
  evidence: CharacterProof;
  distanceSeconds: number;
  presenceAtSelectedFrameConfirmed: boolean;
  method: string;
}
interface SelectedFrame {
  sourceFrameNumber: number;
  timeSeconds: number;
  file: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  thumbnail: string;
  metrics: FrameMetrics;
  selection: string;
  semanticBestMomentVerified: boolean;
  candidates: { sourceFrameNumber: number; metrics: FrameMetrics }[];
}
interface CaptionRecord {
  id: string;
  partition: "train" | "validation" | "test";
  french: SubtitleCue & { cueNumber: number; [field: string]: unknown };
  frame: SelectedFrame;
  nearbyCharacterEvidence: CharacterContext[];
  [field: string]: unknown;
}

/** Decode bounded thumbnails with the native image owner; no PNG parser or inflater here. */
export async function thumbnailPixels(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  if (png.byteLength < 33 || png.byteLength > 1024 * 1024) throw new Error("Invalid bounded thumbnail payload");
  if (typeof Bun.Image.prototype.rgba !== "function") throw new Error("Qualified native Bun.Image.rgba is required");
  const image = new Bun.Image(png, { maxPixels: 256 * 256, autoOrient: false });
  const metadata = await image.metadata();
  if (
    metadata.format !== "png" ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > 256 ||
    metadata.height > 256
  )
    throw new Error("Require a bounded thumbnail PNG at most 256x256");
  const pixels = await image.rgba();
  if (
    pixels.width !== metadata.width ||
    pixels.height !== metadata.height ||
    pixels.channels !== 4 ||
    pixels.data.byteLength !== pixels.width * pixels.height * 4
  )
    throw new Error("Native thumbnail RGBA differs from its metadata");
  return { width: pixels.width, height: pixels.height, rgba: pixels.data };
}

/** Dataset compatibility adapter; the shared WGSL owner computes every metric. */
export async function measureFrameDetail(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: FrameAnalysisOptions,
): Promise<FrameMetrics> {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 4 ||
    height < 4 ||
    width > 256 ||
    height > 256 ||
    rgba.length !== width * height * 4
  )
    throw new Error("Invalid bounded thumbnail pixels");
  if (!options || !["chromium", "native"].includes(options.backend ?? ""))
    throw new Error("Frame analysis requires an explicit GPU backend");
  const { analyzeFrameRgba } = await import("./frame-analysis");
  const result = await analyzeFrameRgba({ data: rgba, width, height }, { ...options, excludeCaptionRegion: true });
  return {
    width,
    height,
    meanLuminance: result.meanLuminance,
    luminanceVariance: result.luminanceVariance,
    laplacianVariance: result.laplacianVariance,
    edgeEnergy: result.edgeEnergy,
    score: result.detailScore,
    lowDetail: result.lowDetail,
    captionRegionExcluded: true,
    computation: result.computation,
    backend: result.backend,
    adapter: result.adapter,
    samples: result.samples,
    elapsedMs: result.elapsedMs,
  };
}

export function overlapCues(cue: SubtitleCue, candidates: readonly SubtitleCue[]) {
  return candidates.flatMap((other, index) => {
    const overlapMs = Math.max(0, Math.min(cue.endMs, other.endMs) - Math.max(cue.startMs, other.startMs));
    return overlapMs
      ? [
          {
            cueNumber: index + 1,
            startMs: other.startMs,
            endMs: other.endMs,
            text: other.text,
            overlapMs,
            frenchCoverage: overlapMs / (cue.endMs - cue.startMs),
            japaneseCoverage: overlapMs / (other.endMs - other.startMs),
          },
        ]
      : [];
  });
}

export function episodeTemporalSplit(episodeId: string, startMs: number): "train" | "validation" | "test" {
  if (!episodeId || !Number.isFinite(startMs) || startMs < 0) throw new Error("Invalid episode split input");
  const block = Math.floor(startMs / 30_000);
  const hex = new Bun.CryptoHasher("sha256").update(`${episodeId}:${block}`).digest("hex");
  const bucket = Number.parseInt(hex.slice(0, 8), 16) % 10;
  return bucket < 8 ? "train" : bucket === 8 ? "validation" : "test";
}

export function cueFrameCandidates(cue: SubtitleCue, fps: { numerator: number; denominator: number }, count: number) {
  if (cue.endMs <= cue.startMs || ![fps.numerator, fps.denominator, count].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error("Invalid frame selection input");
  return [
    ...new Set(
      [0.25, 0.5, 0.75].map(ratio => {
        const time = cue.startMs + (cue.endMs - cue.startMs) * ratio;
        return Math.min(count, Math.max(1, Math.floor(((time / 1000) * fps.numerator) / fps.denominator) + 1));
      }),
    ),
  ];
}

export function assessAsrRepetition(cues: readonly SubtitleCue[]) {
  const counts = new Map<string, number>();
  let eligibleSegments = 0;
  for (const cue of cues) {
    const normalized = cue.text.replace(/\s+/g, "").toLowerCase();
    if (normalized.length < 6) continue;
    eligibleSegments++;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const mostRepeatedSegments = Math.max(0, ...counts.values());
  const ratio = eligibleSegments ? mostRepeatedSegments / eligibleSegments : 0;
  return { mostRepeatedSegments, eligibleSegments, ratio, rejected: mostRepeatedSegments >= 8 && ratio > 0.35 };
}

export function pcm16MonoWave(samples: Uint8Array, sampleRate = 16000) {
  if (samples.length % 2 || sampleRate !== 16000 || samples.length > 16000 * 2 * 30)
    throw new Error("Require a bounded PCM16 mono 16kHz window");
  const bytes = new Uint8Array(44 + samples.length),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length, true);
  bytes.set(samples, 44);
  return bytes;
}

/** Source-sample boundaries are measured; word timestamps and speaker identity remain unverified. */
export async function transcribeJapaneseAudioWindows(episodeRoot: string) {
  const root = resolve(episodeRoot),
    localRoot = resolve(import.meta.dir, "../.local");
  const remainder = relative(localRoot, root);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder))
    throw new Error("ASR windows require ignored episode storage");
  const source = Bun.file(join(root, "dataset/japanese-audio-16k.wav"));
  if (source.size > 128 * 1024 * 1024) throw new Error("Source PCM WAV exceeds bounded analysis size");
  const bytes = new Uint8Array(await source.arrayBuffer()),
    view = new DataView(bytes.buffer);
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE"
  )
    throw new Error("Source audio is not a RIFF WAV");
  let dataOffset = 0,
    dataLength = 0,
    validFormat = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = new TextDecoder().decode(bytes.subarray(offset, offset + 4)),
      length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) throw new Error("Truncated source WAV chunk");
    if (type === "fmt " && length >= 16)
      validFormat =
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === 16000 &&
        view.getUint16(offset + 22, true) === 16;
    if (type === "data") {
      dataOffset = offset + 8;
      dataLength = length;
    }
    offset += 8 + length + (length % 2);
  }
  if (!validFormat || !dataLength || dataLength % 2) throw new Error("Require original PCM16 mono 16kHz source audio");
  const manifest = await Bun.file(join(root, "manifest.json")).json();
  if (!/^[a-z0-9-]+$/.test(manifest.id)) throw new Error("Invalid episode job identifier");
  const home = Bun.env.APHRODY_HOME ?? join(Bun.env.USERPROFILE ?? Bun.env.HOME ?? "", ".aphrody");
  const jobRoot = join(home, "voice/jobs", manifest.id, "windows");
  const windowFile = join(jobRoot, "window.wav");
  const output = {
    producer: "aphrody voice native ASR",
    result: { language: "ja" },
    timingMethod: "fixed-source-audio-window",
    wordTimestampsVerified: false,
    sourcePcmSamples: dataLength / 2,
    sampleRate: 16000,
    windowSeconds: 20,
    transcription: [] as { offsets: { from: number; to: number }; text: string; recognizedLanguage: string | null }[],
  };
  const windowBytes = 20 * 16000 * 2;
  for (let offset = 0, number = 1; offset < dataLength; offset += windowBytes, number++) {
    const length = Math.min(windowBytes, dataLength - offset);
    await Bun.write(windowFile, pcm16MonoWave(bytes.subarray(dataOffset + offset, dataOffset + offset + length)));
    const child = Bun.spawn(
      ["aphrody", "voice", "transcribe", windowFile, "--model", "whisper-large-v3-turbo-q8", "--json"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000 },
    );
    const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    await Bun.write(join(jobRoot, `window-${String(number).padStart(3, "0")}.raw.json`), stdout);
    if (stderr) await Bun.write(join(jobRoot, `window-${String(number).padStart(3, "0")}.log`), stderr);
    if (code !== 0) throw new Error(`Native ASR audio window ${number} failed (${code})`);
    const transcript = JSON.parse(stdout);
    if (typeof transcript.text !== "string") throw new Error("Native ASR window lacks recognized text");
    if (transcript.text.trim())
      output.transcription.push({
        offsets: { from: offset / 32, to: (offset + length) / 32 },
        text: transcript.text.trim(),
        recognizedLanguage: transcript.language ?? null,
      });
    if (number % 10 === 0)
      console.log(JSON.stringify({ japaneseAsrWindowsProcessed: number, total: Math.ceil(dataLength / windowBytes) }));
  }
  const nativePath = join(jobRoot, "timestamped-window-transcript.json");
  await Bun.write(nativePath, JSON.stringify(output, null, 2) + "\n");
  return finalizeJapaneseAsr(root, { nativeJsonPath: nativePath });
}

/** Preserve actual native recognition and timestamps, without manufacturing official subtitles. */
export async function finalizeJapaneseAsr(episodeRoot: string, options: { nativeJsonPath?: string } = {}) {
  const root = resolve(episodeRoot);
  const localRoot = resolve(import.meta.dir, "../.local");
  const remainder = relative(localRoot, root);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder))
    throw new Error("ASR output must stay in ignored episode storage");
  const timedFile = Bun.file(join(root, "subtitles/asr-native-timed.json"));
  const sanitizedFile = Bun.file(join(root, "subtitles/ja-JP.asr.native.json"));
  const fullFile = Bun.file(join(root, "subtitles/asr-native-full.json"));
  const raw = options.nativeJsonPath
    ? await Bun.file(options.nativeJsonPath).json()
    : (await timedFile.exists())
      ? await timedFile.json()
      : (await sanitizedFile.exists())
        ? await sanitizedFile.json()
        : (await fullFile.exists())
          ? await fullFile.json()
          : await Bun.file(join(root, "subtitles/asr-native.json")).json();
  const transcript = Array.isArray(raw.transcription)
    ? {
        language: raw.result?.language,
        segments: raw.transcription.map((segment: { offsets: { from: number; to: number }; text: string }) => ({
          start: segment.offsets.from / 1000,
          end: segment.offsets.to / 1000,
          text: segment.text,
        })),
      }
    : (raw.transcript ?? raw);
  if (!Array.isArray(transcript.segments) || !["ja", "ja-JP", "japanese"].includes(transcript.language))
    throw new Error("Native ASR did not return a timestamped Japanese transcript");
  const untimed: {
    sourceSegmentNumber: number;
    text: string;
    nativeStartSeconds: number;
    nativeEndSeconds: number;
    reason: string;
  }[] = [];
  const cues: SubtitleCue[] = transcript.segments.flatMap(
    (segment: { start: number; end: number; text: string }, index: number) => {
      if (
        typeof segment.text !== "string" ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < 0
      )
        throw new Error("Native ASR returned invalid segment timing");
      const text = segment.text.trim();
      if (text && segment.end <= segment.start) {
        untimed.push({
          sourceSegmentNumber: index + 1,
          text,
          nativeStartSeconds: segment.start,
          nativeEndSeconds: segment.end,
          reason: "Native recognizer emitted an unusable zero or inverted interval; no replacement timestamp invented",
        });
        return [];
      }
      return text ? [{ startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), text }] : [];
    },
  );
  if (!cues.length) throw new Error("Native ASR returned no Japanese dialogue");
  const repetition = assessAsrRepetition(cues);
  if (repetition.rejected) throw new Error("Native ASR rejected: excessive repeated transcription segments");
  const previous = await Bun.file(join(root, "subtitles/asr-ja.json")).json();
  delete previous.code;
  delete previous.reason;
  delete previous.repetition;
  const manifest = await Bun.file(join(root, "manifest.json")).json();
  const lastCueMs = Math.max(...cues.map(cue => cue.endMs));
  if (lastCueMs > manifest.durationSeconds * 1000 + 1000)
    throw new Error("Native ASR timestamps exceed the source duration");
  await Bun.write(
    sanitizedFile,
    JSON.stringify(
      {
        producer: "Aphrody-managed Whisper.cpp native runtime",
        result: { language: transcript.language },
        transcription: transcript.segments.map((segment: { start: number; end: number; text: string }) => ({
          offsets: { from: Math.round(segment.start * 1000), to: Math.round(segment.end * 1000) },
          text: segment.text,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  await Bun.write(join(root, "subtitles/ja-JP.asr.vtt"), renderSubtitle(cues, "vtt"));
  await Bun.write(join(root, "subtitles/ja-JP.asr.srt"), renderSubtitle(cues, "srt"));
  await Bun.write(
    join(root, "subtitles/ja-JP.asr.jsonl"),
    cues
      .map((cue, index) =>
        JSON.stringify({
          cueNumber: index + 1,
          ...cue,
          source: "native-ASR-from-Crunchyroll-Japanese-audio",
          confidence: null,
          semanticVerification: "unreviewed",
        }),
      )
      .join("\n") + "\n",
  );
  await Bun.write(
    join(root, "subtitles/ja-JP.asr.untimed.jsonl"),
    untimed
      .map(segment =>
        JSON.stringify({ ...segment, source: "native-ASR-from-Crunchyroll-Japanese-audio", confidence: null }),
      )
      .join("\n") + "\n",
  );
  const text = cues.map(cue => cue.text).join("");
  const japaneseCharacters = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu)?.length ?? 0;
  const probabilities: number[] = Array.isArray(raw.transcription)
    ? raw.transcription.flatMap((segment: { tokens?: { p: number; text: string }[] }) =>
        (segment.tokens ?? [])
          .filter(token => Number.isFinite(token.p) && token.p >= 0 && token.p <= 1 && !token.text.startsWith("[_"))
          .map(token => token.p),
      )
    : [];
  const receipt = {
    ...previous,
    status: "complete",
    completedAt: new Date().toISOString(),
    audioTranscribed: true,
    sourceVideoSha256: manifest.source.sha256,
    languageDetected: transcript.language,
    cueCount: cues.length,
    nativeSegmentCount: transcript.segments.length,
    untimedSegmentCount: untimed.length,
    firstCueMs: Math.min(...cues.map(cue => cue.startMs)),
    lastCueMs,
    sourceEndPaddingMs: Math.max(0, lastCueMs - manifest.durationSeconds * 1000),
    audioProcessingScope: "whole-source-audio",
    sourceDurationSeconds: manifest.durationSeconds,
    japaneseCharacterRatio: japaneseCharacters / [...text].length,
    confidence: null,
    meanTokenProbability: probabilities.length
      ? probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length
      : null,
    probabilityTokenCount: probabilities.length,
    confidenceReason:
      "Raw native token probabilities are retained separately; they are not calibrated recognition accuracy",
    timestampProducer:
      raw.timingMethod === "fixed-source-audio-window"
        ? "Bun PCM sample boundaries with native Aphrody recognition text"
        : "Aphrody-managed Whisper.cpp native runtime --output-json regular segment timestamps",
    timingMethod: raw.timingMethod ?? "native-recognizer-segment-offsets",
    wordTimestampsVerified: false,
    timestampGranularitySeconds: raw.windowSeconds ?? null,
    sourcePcmSamples: raw.sourcePcmSamples ?? null,
    windowLanguageDetections:
      raw.timingMethod === "fixed-source-audio-window"
        ? raw.transcription.map((segment: { recognizedLanguage?: string }, index: number) => ({
            sourceWindowNumber: index + 1,
            recognizedLanguage: segment.recognizedLanguage ?? null,
          }))
        : null,
    repetitionQualityCheck: repetition,
    japaneseCompleteness: "whole-audio-processed-utterance-accuracy-unverified",
    officialProviderSubtitles: false,
    reviewStatus: "automatic-recognition-unreviewed",
    recognitionUncertainty: true,
    files: ["ja-JP.asr.vtt", "ja-JP.asr.srt", "ja-JP.asr.jsonl", "ja-JP.asr.untimed.jsonl", "ja-JP.asr.native.json"],
  };
  await Bun.write(join(root, "subtitles/asr-ja.json"), JSON.stringify(receipt, null, 2) + "\n");
  const providerProof = await Bun.file(join(root, "subtitles/result-ja.json")).json();
  await Bun.write(
    join(root, "subtitles/result-ja.json"),
    JSON.stringify({ ...providerProof, asr: receipt }, null, 2) + "\n",
  );
  return receipt;
}

export async function createEpisodeDataset(input: { episodeRoot: string; analysis?: FrameAnalysisOptions }) {
  const root = resolve(input.episodeRoot);
  const packageLocal = resolve(import.meta.dir, "../.local");
  const remainder = relative(packageLocal, root);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder))
    throw new Error("Dataset must stay in the ignored package .local directory");
  const manifest = await Bun.file(join(root, "manifest.json")).json();
  const frResult = await Bun.file(join(root, "subtitles/result.json")).json();
  if (frResult.status !== "complete" || frResult.source !== "Crunchyroll")
    throw new Error("Dataset requires actual provider-sourced French subtitles");
  const frText = await Bun.file(join(root, "subtitles/fr-FR.ass")).text();
  const frCues = parseSubtitle(frText, "ass");
  const frTrackSha256 = new Bun.CryptoHasher("sha256").update(frText).digest("hex");
  if (frResult.cueCount !== frCues.length)
    throw new Error("French provider cue count differs from the retrieved track");
  const jaResultFile = Bun.file(join(root, "subtitles/result-ja.json"));
  const jaResult = (await jaResultFile.exists()) ? await jaResultFile.json() : { status: "unavailable" };
  const asrFile = Bun.file(join(root, "subtitles/asr-ja.json"));
  const asrResult = (await asrFile.exists()) ? await asrFile.json() : { status: "unavailable" };
  let jaCues: SubtitleCue[] = [];
  let japaneseTextSource: string | null = null;
  if (jaResult.status === "complete") {
    for (const format of ["ass", "vtt", "srt"] as const) {
      const file = Bun.file(join(root, `subtitles/ja-JP.${format}`));
      if (await file.exists()) {
        jaCues = parseSubtitle(await file.text(), format);
        japaneseTextSource = "Crunchyroll";
        break;
      }
    }
    if (!jaCues.length) throw new Error("Japanese provider receipt is complete but its subtitle track is missing");
  } else if (asrResult.status === "complete") {
    const file = Bun.file(join(root, "subtitles/ja-JP.asr.vtt"));
    if (!(await file.exists())) throw new Error("Japanese ASR receipt is complete but its transcript is missing");
    jaCues = parseSubtitle(await file.text(), "vtt");
    japaneseTextSource = "native-ASR-from-Crunchyroll-Japanese-audio";
  }
  const characters: CharacterMetadata[] = (await Bun.file(join(root, "characters.json")).json()).characters ?? [];
  const lexiconFile = Bun.file(join(root, "dataset/lexicon.json"));
  const lexicon: { canonicalEpisodeCharacters?: { status: string }[] } | null = (await lexiconFile.exists())
    ? await lexiconFile.json()
    : null;
  const output = join(root, "dataset");
  const metricCache = new Map<number, { metrics: FrameMetrics; thumbnail: string }>();
  const records: CaptionRecord[] = [];
  const fps = manifest.fps as { numerator: number; denominator: number };
  let index = 0;
  for (const cue of frCues) {
    const candidates = cueFrameCandidates(cue, fps, manifest.frameCount);
    const scored = [];
    for (const number of candidates) {
      const file = `frames/frame-${String(number).padStart(6, "0")}.png`;
      if (!(await Bun.file(join(root, file)).exists())) throw new Error(`Missing original frame ${number}`);
      if (!metricCache.has(number)) {
        const bytes = await new Bun.Image(join(root, file)).resize(160, 90).png().bytes();
        const pixels = await thumbnailPixels(bytes);
        const thumbnail = `dataset/thumbnails/frame-${String(number).padStart(6, "0")}.png`;
        await Bun.write(join(root, thumbnail), bytes);
        const metrics = await measureFrameDetail(pixels.rgba, pixels.width, pixels.height, {
          backend: "chromium",
          chromiumExecutable: Bun.env.BUN_VIDEO_CHROMIUM_EXECUTABLE,
          timeout: 5000,
          ...input.analysis,
        });
        metricCache.set(number, { metrics, thumbnail });
      }
      scored.push({ number, file, ...metricCache.get(number)! });
    }
    scored.sort((a, b) => b.metrics.score - a.metrics.score || a.number - b.number);
    const best = scored[0]!;
    const timeSeconds = ((best.number - 1) * fps.denominator) / fps.numerator;
    const frameBytes = new Uint8Array(await Bun.file(join(root, best.file)).arrayBuffer());
    const context = characters.flatMap(character =>
      character.evidence
        .filter(proof => Math.abs(proof.timeSeconds - timeSeconds) <= 5)
        .map(proof => ({
          id: character.id,
          nameFr: character.name,
          evidence: proof,
          distanceSeconds: Math.abs(proof.timeSeconds - timeSeconds),
          presenceAtSelectedFrameConfirmed: false,
          method: "nearby-manual-visual-evidence",
        })),
    );
    const matches = overlapCues(cue, jaCues);
    records.push({
      schema: "bun-video/episode-caption-frame/v1",
      id: `${manifest.id}:fr-FR:${++index}`,
      episodeId: manifest.id,
      providerEpisodeId: frResult.episodeId,
      sourceVideoSha256: manifest.source.sha256,
      sourceAudioLocale: "ja-JP",
      sourceMedium: "anime-episode",
      partition: episodeTemporalSplit(manifest.id, cue.startMs),
      french: {
        cueNumber: index,
        ...cue,
        source: "Crunchyroll",
        trackKey: frResult.trackKey ?? `${frResult.episodeId}:fr-FR:subtitle`,
        trackSha256: frResult.trackSha256 ?? frTrackSha256,
      },
      japanese: jaCues.length
        ? {
            status: matches.length ? "timing-aligned" : "no-temporal-overlap",
            source: japaneseTextSource,
            officialProviderTrack: japaneseTextSource === "Crunchyroll",
            confidence: japaneseTextSource === "Crunchyroll" ? null : (asrResult.confidence ?? null),
            asrUncertainty:
              japaneseTextSource === "Crunchyroll"
                ? null
                : "Automatic recognition; not an official provider subtitle and not semantically verified",
            cues: matches,
            semanticTranslationEquivalenceVerified: false,
          }
        : {
            status: "provider-track-unavailable",
            text: null,
            cues: [],
            reasonCode: jaResult.code ?? "NO_JAPANESE_PROVIDER_TRACK",
          },
      frame: {
        sourceFrameNumber: best.number,
        timeSeconds,
        file: best.file,
        bytes: frameBytes.length,
        width: manifest.width,
        height: manifest.height,
        sha256: new Bun.CryptoHasher("sha256").update(frameBytes).digest("hex"),
        thumbnail: best.thumbnail,
        metrics: best.metrics,
        selection: "highest-image-detail-of-three-cue-interior-candidates",
        semanticBestMomentVerified: false,
        candidates: scored.map(c => ({ sourceFrameNumber: c.number, metrics: c.metrics })),
      },
      nearbyCharacterEvidence: context,
      annotation: {
        subtitleSpeechSpeaker: null,
        visibleCharacters: null,
        sceneDescriptionJa: null,
        speakerAttributionVerified: false,
        imageCaptionSemanticCorrespondenceVerified: false,
        humanReviewRequired: true,
      },
    });
  }
  for (const partition of ["train", "validation", "test"] as const) {
    await Bun.write(
      join(output, `${partition}.jsonl`),
      records
        .filter(r => r.partition === partition)
        .map(r => JSON.stringify(r))
        .join("\n") + "\n",
    );
  }
  await Bun.write(join(output, "all-cues.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  await Bun.write(join(output, "fr-cues.json"), JSON.stringify(frCues, null, 2) + "\n");
  await Bun.write(join(output, "ja-cues.json"), JSON.stringify(jaCues, null, 2) + "\n");
  const ranked = [...records]
    .sort((a, b) => b.frame.metrics.score - a.frame.metrics.score)
    .slice(0, 32)
    .map(r => ({
      cueId: r.id,
      frenchCueNumber: r.french.cueNumber,
      frame: r.frame,
      nearbyCharacterEvidence: r.nearbyCharacterEvidence,
    }));
  await Bun.write(join(output, "best-frames.json"), JSON.stringify(ranked, null, 2) + "\n");
  const summary = {
    schema: "bun-video/episode-dataset/v1",
    episodeId: manifest.id,
    providerEpisodeId: frResult.episodeId,
    createdAt: new Date().toISOString(),
    status: jaCues.length ? "caption-pairs-prepared-for-review" : "french-complete-japanese-provider-track-unavailable",
    source: {
      file: "source.mp4",
      sha256: manifest.source.sha256,
      audioLocale: "ja-JP",
      hardcodedSubtitleLocale: "fr-FR",
      durationSeconds: manifest.durationSeconds,
    },
    captions: {
      french: frCues.length,
      japanese: jaCues.length,
      frenchCompleteness: "all-cues-of-retrieved-provider-track",
      japaneseProof: jaResult,
      japaneseTextSource,
      japaneseAsrProof: asrResult,
      japaneseCompleteness: jaResult.status === "complete" && jaCues.length > 0,
    },
    frames: {
      originalSequenceCount: manifest.frameCount,
      annotatedCueFrames: records.length,
      measuredCandidates: metricCache.size,
      thumbnailWidth: 160,
      thumbnailHeight: 90,
      originalFramesCopied: false,
      imageDetailRankingOnly: true,
    },
    splits: Object.fromEntries(
      ["train", "validation", "test"].map(p => [p, records.filter(r => r.partition === p).length]),
    ),
    splitMethod: "deterministic-SHA256-30-second-episode-blocks-80-10-10",
    sourceEpisodeHoldout: false,
    sameEpisodeLeakagePossible: true,
    generalizationQualification: "requires-held-out-source-episodes",
    readyForUnreviewedFineTuning: false,
    canonicalScope: "Anime evidence, not automatic manga canon, lexicon updates or Shenron database ingestion",
    modelTrainingPerformed: false,
    shenronDatabaseModified: false,
    japaneseLexiconConfirmedNames:
      lexicon?.canonicalEpisodeCharacters?.filter(e => e.status === "confirmed").length ?? 0,
    files: [
      "all-cues.jsonl",
      "train.jsonl",
      "validation.jsonl",
      "test.jsonl",
      "fr-cues.json",
      "ja-cues.json",
      "best-frames.json",
      "lexicon.json",
    ],
  };
  await Bun.write(join(output, "result.json"), JSON.stringify(summary, null, 2) + "\n");
  await Bun.write(
    join(output, "japanese-source-version.json"),
    JSON.stringify(
      {
        source: "../source.mp4",
        audioLocale: "ja-JP",
        dubbingGenerated: false,
        videoBytesModified: false,
        alternativeMediaCopyCreated: false,
        japaneseProviderSubtitles: jaCues.length > 0,
        burnedInFrenchSubtitlesRemainInOriginalSource: true,
      },
      null,
      2,
    ) + "\n",
  );
  return summary;
}

if (import.meta.main) {
  const windows = Bun.argv[2] === "--asr-windows";
  const finalize = Bun.argv[2] === "--finalize-asr";
  const root = Bun.argv[finalize || windows ? 3 : 2] ?? resolve(import.meta.dir, "../.local/episodes/beerus-01");
  if (windows) await transcribeJapaneseAudioWindows(root);
  if (finalize) await finalizeJapaneseAsr(root, { nativeJsonPath: Bun.argv[4] });
  console.log(JSON.stringify(await createEpisodeDataset({ episodeRoot: root })));
}
