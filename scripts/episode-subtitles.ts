#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

function timestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error("Invalid subtitle timestamp");
  return (
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]!.padEnd(3, "0"))
  );
}

export function parseSubtitle(text: string, format: "ass" | "vtt" | "srt"): SubtitleCue[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const cues: SubtitleCue[] = [];
  if (format === "ass") {
    let events = false;
    let fields: string[] = [];
    for (const line of lines) {
      if (line.startsWith("[")) events = line.trim() === "[Events]";
      if (!events) continue;
      if (line.startsWith("Format:"))
        fields = line
          .slice(7)
          .split(",")
          .map(field => field.trim().toLowerCase());
      if (!line.startsWith("Dialogue:")) continue;
      if (fields.at(-1) !== "text" || !fields.includes("start") || !fields.includes("end"))
        throw new Error("Unsupported ASS event fields");
      const values = line.slice(9).split(",");
      const raw = values.slice(fields.length - 1).join(",");
      // Drawing events are graphics, not dialogue. Preserve them in the original ASS only.
      if (/\\p[1-9]\d*\b/.test(raw)) continue;
      cues.push({
        startMs: timestamp(values[fields.indexOf("start")]!),
        endMs: timestamp(values[fields.indexOf("end")]!),
        text: raw
          .replace(/\{[^}]*\}/g, "")
          .replace(/\\[Nn]/g, "\n")
          .replace(/\\h/g, "\u00a0")
          .trim(),
      });
    }
  } else {
    for (const block of lines.join("\n").split(/\n\s*\n/)) {
      const rows = block.split("\n");
      if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(rows[0] ?? "")) continue;
      const index = rows.findIndex(row => row.includes("-->"));
      if (index < 0) continue;
      const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(rows[index]!);
      if (!match) throw new Error("Invalid subtitle cue");
      cues.push({
        startMs: timestamp(match[1]!),
        endMs: timestamp(match[2]!),
        text: rows
          .slice(index + 1)
          .join("\n")
          .trim(),
      });
    }
  }
  if (!cues.length) throw new Error("Subtitle track contains no dialogue cues");
  for (const cue of cues) {
    if (cue.endMs <= cue.startMs || cue.startMs < 0 || !cue.text)
      throw new Error("Invalid subtitle cue interval or text");
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function timecode(ms: number, separator: string): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
}

export function renderSubtitle(cues: readonly SubtitleCue[], format: "vtt" | "srt"): string {
  const separator = format === "vtt" ? "." : ",";
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    cues
      .map((cue, index) => {
        const text =
          format === "vtt" ? cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : cue.text;
        return `${index + 1}\n${timecode(cue.startMs, separator)} --> ${timecode(cue.endMs, separator)}\n${text}\n`;
      })
      .join("\n")
  );
}

interface Episode {
  id: string;
  title: string;
  episode_metadata: {
    series_title: string;
    episode_number: number;
    duration_ms: number;
    audio_locale?: string;
  };
}

export function matchingEpisode(value: unknown, title: string, series: string): Episode | undefined {
  const data = (value as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return;
  return data.find(
    (row: any) =>
      row?.title === title &&
      row?.episode_metadata?.series_title === series &&
      row?.episode_metadata?.episode_number === 1 &&
      typeof row.id === "string" &&
      /^[A-Z0-9]{9,32}$/.test(row.id) &&
      Number.isFinite(row.episode_metadata.duration_ms),
  ) as Episode | undefined;
}

function privateBodyPath(directory: string, bodyFile: string): string {
  const path = resolve(directory, bodyFile);
  const remainder = relative(directory, path);
  if (isAbsolute(bodyFile) || remainder.startsWith("..") || isAbsolute(remainder))
    throw new Error("Capture body escapes protected directory");
  return path;
}

/** Discover only subtitle URLs returned by an owner-authorized capture for the exact episode. */
export async function capturedSubtitle(captureRoot: string, locale = "fr-FR") {
  const inspected: Array<{
    episodeId: string;
    audioLocale: string | null;
    subtitleLocales: string[];
    captionLocales: string[];
    hardSubLocales: string[];
  }> = [];
  for (const directoryEntry of await readdir(captureRoot, { withFileTypes: true })) {
    if (!directoryEntry.isDirectory()) continue;
    const directory = join(captureRoot, directoryEntry.name);
    const indexFile = Bun.file(join(directory, "capture-index.json"));
    if (!(await indexFile.exists())) continue;
    const index = await indexFile.json();
    if (!Array.isArray(index.requests)) continue;
    let episode: Episode | undefined;
    for (const request of index.requests) {
      if (request.kind !== "json" || request.response?.status !== 200 || typeof request.bodyFile !== "string") continue;
      const url = new URL(request.request.url);
      if (url.origin !== "https://www.crunchyroll.com" || !url.pathname.startsWith("/content/v2/cms/objects/"))
        continue;
      const body = await Bun.file(privateBodyPath(directory, request.bodyFile)).json();
      episode = matchingEpisode(body, "Le dieu de la Destruction", "Dragon Ball Super: Beerus");
      if (episode) break;
    }
    if (!episode) continue;
    for (const request of index.requests) {
      if (request.kind !== "json" || request.response?.status !== 200 || typeof request.bodyFile !== "string") continue;
      const url = new URL(request.request.url);
      if (
        url.origin !== "https://www.crunchyroll.com" ||
        !url.pathname.startsWith(`/playback/v3/${episode.id}/`) ||
        !url.pathname.endsWith("/play")
      )
        continue;
      const body = await Bun.file(privateBodyPath(directory, request.bodyFile)).json();
      inspected.push({
        episodeId: episode.id,
        audioLocale: body.audioLocale ?? null,
        subtitleLocales: Object.keys(body.subtitles ?? {}),
        captionLocales: Object.keys(body.captions ?? {}),
        hardSubLocales: Object.keys(body.hardSubs ?? {}),
      });
      const trackType = body.subtitles?.[locale] ? "subtitle" : "caption";
      const track = body.subtitles?.[locale] ?? body.captions?.[locale];
      if (!track || !["ass", "vtt", "srt"].includes(track.format) || typeof track.url !== "string") continue;
      const subtitleUrl = new URL(track.url);
      if (
        subtitleUrl.protocol !== "https:" ||
        subtitleUrl.username ||
        subtitleUrl.password ||
        subtitleUrl.port ||
        !(subtitleUrl.hostname === "crunchyrollcdn.com" || subtitleUrl.hostname.endsWith(".crunchyrollcdn.com"))
      )
        throw new Error("Subtitle URL is outside the authorized Crunchyroll CDN");
      return { episode, locale, trackType, format: track.format as "ass" | "vtt" | "srt", url: subtitleUrl };
    }
  }
  throw new SubtitleTrackUnavailable(locale, inspected);
}

export class SubtitleTrackUnavailable extends Error {
  constructor(
    readonly locale: string,
    readonly inspected: readonly {
      episodeId: string;
      audioLocale: string | null;
      subtitleLocales: string[];
      captionLocales: string[];
      hardSubLocales: string[];
    }[],
  ) {
    super("Requested Crunchyroll subtitle or caption locale is absent from the matching captured playback responses");
  }
}

export async function episodeSubtitlesMain(args = Bun.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "bun scripts/episode-subtitles.ts [--locale fr-FR|ja-JP] [--output ignored-directory] [--capture-root protected-directory]\nFetches only provider-supplied subtitle/caption tracks for the exact local Beerus episode. A missing Japanese track remains explicit. No video, license, cookie or token export.",
    );
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--output", "--capture-root", "--locale"].includes(args[i]!) || !args[i + 1])
      throw new Error("Invalid subtitle option");
    options.set(args[i]!, args[i + 1]!);
  }
  const home = Bun.env.APHRODY_HOME ?? join(Bun.env.USERPROFILE ?? Bun.env.HOME ?? "", ".aphrody");
  const locale = options.get("--locale") ?? "fr-FR";
  if (!["fr-FR", "ja-JP"].includes(locale)) throw new Error("Unsupported requested subtitle locale");
  const output = resolve(options.get("--output") ?? join(import.meta.dir, "../.local/episodes/beerus-01/subtitles"));
  const localRoot = resolve(import.meta.dir, "../.local");
  const outputRelative = relative(localRoot, output);
  if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative))
    throw new Error("Subtitle output must stay in this package's ignored .local directory");
  let result: Record<string, unknown>;
  try {
    const track = await capturedSubtitle(
      resolve(options.get("--capture-root") ?? join(home, "cookies/bun-video/captures")),
      locale,
    );
    const response = await fetch(track.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) {
      result = {
        status: "blocked",
        code: "SUBTITLE_HTTP_ERROR",
        httpStatus: response.status,
        episodeId: track.episode.id,
      };
    } else {
      if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024)
        throw new Error("Subtitle track exceeds size limit");
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new Error("Subtitle track exceeds size limit");
      const cues = parseSubtitle(text, track.format);
      const originalFile = track.format === "ass" ? `${locale}.ass` : `${locale}.source.${track.format}`;
      await Bun.write(join(output, originalFile), text);
      await Bun.write(join(output, `${locale}.vtt`), renderSubtitle(cues, "vtt"));
      await Bun.write(join(output, `${locale}.srt`), renderSubtitle(cues, "srt"));
      result = {
        status: "complete",
        source: "Crunchyroll",
        acquisition: "authorized-capture-discovered-track",
        retrievedAt: new Date().toISOString(),
        httpStatus: 200,
        episodeId: track.episode.id,
        episodeTitle: track.episode.title,
        seriesTitle: track.episode.episode_metadata.series_title,
        episodeNumber: 1,
        durationMs: track.episode.episode_metadata.duration_ms,
        locale: track.locale,
        trackType: track.trackType,
        trackKey: `${track.episode.id}:${locale}:${track.trackType}`,
        providerTrackId: null,
        trackSha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
        cueCount: cues.length,
        originalFormat: track.format,
        files: [originalFile, `${locale}.vtt`, `${locale}.srt`],
        firstCueMs: cues[0]!.startMs,
        lastCueMs: Math.max(...cues.map(cue => cue.endMs)),
        burnedInSourceCaptions: true,
        defaultOverlay: false,
        conversion: "Dialogue text and timings; original ASS retains styling and placement",
        signedUrlsExported: false,
        secretsExported: false,
      };
    }
  } catch (error) {
    if (error instanceof SubtitleTrackUnavailable) {
      result = {
        status: "unavailable",
        source: "Crunchyroll",
        code: "PROVIDER_LOCALE_NOT_OFFERED_IN_CAPTURE",
        locale,
        inspected: error.inspected,
        capturedMetadataHttpStatus: 200,
        generatedJapaneseTranslation: false,
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
      const probe = Bun.file(join(output, "live-ja-probe.json"));
      if (locale === "ja-JP" && (await probe.exists())) result.liveProbe = await probe.json();
      const asr = Bun.file(join(output, "asr-ja.json"));
      if (locale === "ja-JP" && (await asr.exists())) result.asr = await asr.json();
      await Bun.write(
        join(output, locale === "ja-JP" ? "result-ja.json" : "result.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result));
      process.exitCode = 1;
      return;
    }
    // Provider bodies, captured URLs and transport errors remain private.
    const known = new Set([
      "No matching French Crunchyroll subtitle track in protected captures",
      "Subtitle URL is outside the authorized Crunchyroll CDN",
      "Capture body escapes protected directory",
      "Subtitle track contains no dialogue cues",
      "Unsupported ASS event fields",
      "Invalid subtitle timestamp",
      "Invalid subtitle cue",
      "Invalid subtitle cue interval or text",
      "Subtitle track exceeds size limit",
    ]);
    result = {
      status: "blocked",
      code: "SUBTITLE_ACQUISITION_FAILED",
      message:
        error instanceof Error && known.has(error.message)
          ? error.message
          : "Protected subtitle input or network request unavailable",
    };
  }
  await Bun.write(
    join(output, locale === "ja-JP" ? "result-ja.json" : "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  if (result.status !== "complete") process.exitCode = 1;
}

if (import.meta.main) await episodeSubtitlesMain();
