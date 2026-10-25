#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

type HarEntry = {
  request: { url: string };
  response: { status: number; content: { mimeType: string; text?: string; encoding?: string } };
};

export function validateHar(value: unknown): HarEntry[] {
  const entries = (value as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Invalid HAR: log.entries must be an array.");
  for (const entry of entries) {
    if (
      typeof entry?.request?.url !== "string" ||
      !Number.isInteger(entry?.response?.status) ||
      typeof entry?.response?.content?.mimeType !== "string" ||
      (entry.response.content.text !== undefined && typeof entry.response.content.text !== "string") ||
      (entry.response.content.encoding !== undefined && entry.response.content.encoding !== "base64")
    )
      throw new Error("Invalid HAR entry structure.");
    try {
      new URL(entry.request.url);
    } catch {
      throw new Error("Invalid HAR request URL.");
    }
  }
  return entries;
}

const attributes = (tag: string) => {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) result[match[1]!] = match[3]!;
  return result;
};
const numberAttribute = (value: string | undefined) => {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export function validateCapturedManifest(text: string, mimeType: string) {
  if (text.trimStart().startsWith("#EXTM3U")) {
    return {
      kind: "hls" as const,
      segmentCount: (text.match(/^#EXTINF:/gm) ?? []).length,
      variantCount: (text.match(/^#EXT-X-STREAM-INF:/gm) ?? []).length,
      encrypted: /^#EXT-X-KEY:(?![^\r\n]*METHOD=NONE)/m.test(text),
    };
  }
  if (!/<(?:\w+:)?MPD\b/.test(text)) {
    if (/dash\+xml|mpegurl/i.test(mimeType)) throw new Error("Captured manifest has an unrecognized format.");
    return null;
  }
  if (!/<\/(?:\w+:)?MPD\s*>/.test(text)) throw new Error("Captured DASH manifest is incomplete.");
  const mpd = attributes(text.match(/<(?:\w+:)?MPD\b[^>]*>/)![0]);
  const duration = mpd.mediaPresentationDuration;
  const systems = new Set<string>();
  for (const tag of text.matchAll(/<(?:\w+:)?ContentProtection\b[^>]*>/g)) {
    const scheme = attributes(tag[0]).schemeIdUri?.toLowerCase();
    const uuid = scheme?.match(/^urn:uuid:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/)?.[1];
    if (uuid) {
      systems.add(
        uuid === "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
          ? "Widevine"
          : uuid === "9a04f079-9840-4286-ab92-e65be0885f95"
            ? "PlayReady"
            : uuid,
      );
    } else
      systems.add(scheme === "urn:mpeg:dash:mp4protection:2011" ? "CommonEncryption" : "UnrecognizedProtectionScheme");
  }
  const representations = [...text.matchAll(/<(?:\w+:)?Representation\b[^>]*>/g)].map(tag => {
    const attrs = attributes(tag[0]);
    return {
      width: numberAttribute(attrs.width),
      height: numberAttribute(attrs.height),
      bandwidth: numberAttribute(attrs.bandwidth),
      codecs: attrs.codecs && /^[\w., -]{1,100}$/.test(attrs.codecs) ? attrs.codecs : undefined,
    };
  });
  return {
    kind: "dash" as const,
    duration: duration && /^P[\d.YMDTHS]+$/.test(duration) ? duration : undefined,
    contentProtectionSystems: [...systems].sort(),
    representations,
  };
}

export function analyzeHar(value: unknown, html = "") {
  const entries = validateHar(value);
  const hosts: Record<string, number> = {};
  const mimeTypes: Record<string, number> = {};
  const statusClasses: Record<string, number> = {};
  let jsonResponses = 0,
    invalidJsonResponses = 0,
    crunchyrollJsonResponses = 0;
  const manifests: Array<{
    entryIndex: number;
    host: string;
    manifest: NonNullable<ReturnType<typeof validateCapturedManifest>>;
  }> = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const host = new URL(entry.request.url).hostname;
    hosts[host] = (hosts[host] ?? 0) + 1;
    const content = entry.response.content;
    const mime = content.mimeType.split(";")[0]!.trim().toLowerCase();
    const safeMime = /^[a-z\d.+-]+\/[a-z\d.+-]+$/.test(mime) ? mime : "unknown";
    mimeTypes[safeMime] = (mimeTypes[safeMime] ?? 0) + 1;
    const statusClass = entry.response.status === 0 ? "unavailable" : `${Math.floor(entry.response.status / 100)}xx`;
    statusClasses[statusClass] = (statusClasses[statusClass] ?? 0) + 1;
    if (content.text === undefined) continue;
    const body = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
    if (/\/(?:[\w.+-]*\+)?json$/.test(mime)) {
      try {
        JSON.parse(body);
        jsonResponses++;
        if (host === "crunchyroll.com" || host.endsWith(".crunchyroll.com")) crunchyrollJsonResponses++;
      } catch {
        invalidJsonResponses++;
      }
    }
    const manifest = validateCapturedManifest(body, mime);
    if (manifest) manifests.push({ entryIndex, host, manifest });
  }
  return {
    schemaVersion: 1,
    entryCount: entries.length,
    hosts,
    mimeTypes,
    statusClasses,
    jsonResponses,
    invalidJsonResponses,
    crunchyrollJsonResponses,
    manifests,
    hlsManifestCount: manifests.filter(item => item.manifest.kind === "hls").length,
    dashManifestCount: manifests.filter(item => item.manifest.kind === "dash").length,
    html: {
      videoElementCount: (html.match(/<video\b/gi) ?? []).length,
      hasBlobSource: /\bsrc\s*=\s*["']blob:/i.test(html),
      hasBitmovinPlayer: /bitmovinplayer/i.test(html),
    },
    qualification: {
      captureParsed: true,
      playbackValidated: false,
      apiMigrationValidated: false,
      drmLicenseValidated: false,
    },
  };
}

export async function main(args = Bun.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "bun-video har [--har <absolute private HAR>] [--html <absolute private HTML>]\nWrites a redacted summary in .coord under the working directory; never logs captured bodies.",
    );
    return;
  }
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--")))
      throw new Error(`Missing value for ${name}.`);
    return resolve(index >= 0 ? args[index + 1]! : fallback);
  };
  const root = resolve(process.cwd());
  const harPath = option("--har", resolve(root, "tmp/test/www.crunchyroll.com.har"));
  const htmlPath = option("--html", resolve(root, "tmp/test/test.html"));
  const summary = analyzeHar(await Bun.file(harPath).json(), await Bun.file(htmlPath).text());
  const output = resolve(root, ".coord/browser-har-qualification.json");
  await mkdir(resolve(root, ".coord"), { recursive: true });
  await Bun.write(output, JSON.stringify(summary, null, 2) + "\n");
  console.log(
    JSON.stringify({
      output,
      entryCount: summary.entryCount,
      hlsManifestCount: summary.hlsManifestCount,
      dashManifestCount: summary.dashManifestCount,
      qualification: summary.qualification,
    }),
  );
}

if (import.meta.main)
  main().catch(() => {
    console.error("Video lab failed; check private inputs and options. Captured values are omitted.");
    process.exitCode = 1;
  });

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = main;
