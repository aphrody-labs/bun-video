import type { EpisodePackageManifest as AssetManifest, EpisodeAsset } from "./episode-assets";

/** Producer shape checked against Shenron packages/media/src/episode-video-delivery.ts. */
export interface ShenronEpisodeVideoDelivery {
  producer: "bun-video";
  episodeId: number;
  source: { url: string; sha256: string; bytes: number };
  video: { width: number; height: number; durationSeconds: number };
  frames: Array<{
    url: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    timecodeSeconds: number;
    format: "png";
  }>;
  subtitles?: Array<{ url: string; language: string; label: string; sha256: string }>;
}

export interface ShenronEpisodeDeliveryOptions {
  /** Database wiki ID; this is not the episode number or Crunchyroll ID. */
  episodeId: number;
  sourceUrl: string;
  publicAssetOrigin: string;
  /** Explicitly qualified URLs keyed by archive-relative asset path. */
  assetUrls: Readonly<Record<string, string>>;
  maxFrames?: number;
}

export function controlCharacters(value: string) {
  return [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127);
}

export function publicURL(value: string): URL {
  const url = new URL(value);
  const path = decodeURIComponent(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value ||
    value.length > 4096 ||
    controlCharacters(path) ||
    path.includes("\\") ||
    path.split("/").some(segment => segment === "." || segment === "..")
  )
    throw new Error("Require canonical HTTPS URLs without credentials or query data");
  return url;
}

function assetPath(value: string) {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    controlCharacters(value) ||
    value.split("/").some(part => !part || part === "." || part === "..")
  )
    throw new Error("Require safe archive-relative asset paths");
  return value;
}

function metadata(asset: EpisodeAsset) {
  assetPath(asset.path);
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1)
    throw new Error("Require hashed nonempty assets");
  return asset;
}

/** Keep every frame in the asset manifest; the consumer intake accepts at most 600 PNGs. */
export function selectShenronEpisodeFrames(manifest: AssetManifest, maximum = 240): EpisodeAsset[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 600)
    throw new RangeError("Shenron frame delivery is bounded to 1..600 frames");
  if (
    ![manifest.episode.width, manifest.episode.height].every(
      value => Number.isSafeInteger(value) && value > 0 && value <= 16384,
    )
  )
    throw new Error("Invalid original video dimensions");
  const frames = manifest.assets
    .filter(asset => asset.kind === "frame" && asset.mime === "image/png")
    .sort((a, b) => (a.frameNumber ?? 0) - (b.frameNumber ?? 0));
  if (!frames.length) throw new Error("Shenron intake requires original-resolution PNG frames");
  const seen = new Set<number>();
  for (const frame of frames) {
    metadata(frame);
    if (frame.reference.episodeId !== manifest.episode.source.providerEpisodeId)
      throw new Error("Frame provenance differs from the selected provider episode");
    if (
      !Number.isSafeInteger(frame.frameNumber) ||
      frame.frameNumber! < 1 ||
      frame.frameNumber! > manifest.episode.frameCount ||
      seen.has(frame.frameNumber!)
    )
      throw new Error("Frame numbers must be unique source indices starting at one");
    seen.add(frame.frameNumber!);
    if (
      frame.width !== manifest.episode.width ||
      frame.height !== manifest.episode.height ||
      frame.bytes > 33 * 1024 ** 2
    )
      throw new Error("Shenron frames must preserve original dimensions and bounded PNG bytes");
  }
  if (frames.length <= maximum) return frames;
  if (maximum === 1) return [frames[0]!];
  return Array.from(
    { length: maximum },
    (_, index) => frames[Math.round((index * (frames.length - 1)) / (maximum - 1))]!,
  );
}

export function createShenronEpisodeDraft(manifest: AssetManifest, maximum = 240) {
  const episode = manifest.episode;
  const frames = selectShenronEpisodeFrames(manifest, maximum);
  if (!/^[A-Z0-9]{8,32}$/.test(episode.source.providerEpisodeId))
    throw new Error("Invalid provider episode identifier");
  return {
    schema: "bun-video/shenron-episode-draft/v1" as const,
    producer: "bun-video" as const,
    status: "local-draft" as const,
    contractSource: "shenron/packages/media/src/episode-video-delivery.ts",
    episode: {
      provider: episode.source.provider,
      providerEpisodeId: episode.source.providerEpisodeId,
      title: episode.title,
      sourceUrl: `https://www.crunchyroll.com/watch/${episode.source.providerEpisodeId}`,
      continuity: "dragon-ball-super-anime" as const,
      canonVerdict: null,
    },
    source: { file: assetPath(episode.source.file), sha256: episode.source.sha256, bytes: episode.source.bytes },
    video: {
      width: episode.width,
      height: episode.height,
      durationSeconds: episode.durationSeconds,
      fps: episode.fps,
      frameCount: episode.frameCount,
    },
    frameSelection: frames.map(asset => ({
      path: asset.path,
      sha256: asset.sha256,
      bytes: asset.bytes,
      width: asset.width!,
      height: asset.height!,
      format: "png" as const,
      timecodeSeconds: ((asset.frameNumber! - 1) * episode.fps.denominator) / episode.fps.numerator,
    })),
    subtitles: manifest.assets
      .filter(asset => asset.kind === "subtitle" && asset.mime === "text/vtt")
      .map(asset => ({ path: asset.path, sha256: asset.sha256, language: asset.language, label: asset.language })),
    fullAssetManifest: "package/manifest.json",
    requiredForDelivery: ["qualified-numeric-wiki-episode-id", "qualified-custom-domain-asset-URLs"] as const,
    publicationPerformed: false,
    ingestionPerformed: false,
  };
}

/** Pure conversion only. The caller owns URL qualification; no upload or editorial write occurs. */
export function createShenronEpisodeDelivery(
  manifest: AssetManifest,
  options: ShenronEpisodeDeliveryOptions,
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
  const episode = manifest.episode;
  if (
    !/^[a-f0-9]{64}$/.test(episode.source.sha256) ||
    !Number.isSafeInteger(episode.source.bytes) ||
    episode.source.bytes < 1 ||
    episode.source.bytes > 2 * 1024 ** 3 ||
    !Number.isFinite(episode.durationSeconds) ||
    episode.durationSeconds < 1 ||
    episode.durationSeconds > 86400 ||
    !Number.isSafeInteger(episode.fps.numerator) ||
    episode.fps.numerator < 1 ||
    !Number.isSafeInteger(episode.fps.denominator) ||
    episode.fps.denominator < 1
  )
    throw new Error("Invalid qualified source metadata");
  const urlFor = (asset: EpisodeAsset, extension: string) => {
    metadata(asset);
    const value = options.assetUrls[asset.path];
    if (!value) throw new Error(`No qualified public URL for ${asset.path}`);
    const url = publicURL(value);
    if (url.origin !== origin.origin || !url.pathname.toLowerCase().endsWith(extension))
      throw new Error("Public artifact URL differs from its qualified origin or format");
    return url.href;
  };
  const frames = selectShenronEpisodeFrames(manifest, options.maxFrames).map(asset => {
    const timecodeSeconds = ((asset.frameNumber! - 1) * episode.fps.denominator) / episode.fps.numerator;
    if (timecodeSeconds >= episode.durationSeconds) throw new Error("Frame timestamp lies outside episode duration");
    return {
      url: urlFor(asset, ".png"),
      sha256: asset.sha256,
      bytes: asset.bytes,
      width: asset.width!,
      height: asset.height!,
      timecodeSeconds,
      format: "png" as const,
    };
  });
  const subtitles = manifest.assets
    .filter(asset => asset.kind === "subtitle" && asset.mime === "text/vtt")
    .map(asset => {
      if (
        !asset.language ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(asset.language) ||
        asset.language.length > 120 ||
        !asset.language.isWellFormed() ||
        controlCharacters(asset.language)
      )
        throw new Error("Require a normalized external VTT language and label");
      return { url: urlFor(asset, ".vtt"), language: asset.language, label: asset.language, sha256: asset.sha256 };
    });
  if (
    subtitles.length > 32 ||
    new Set([...frames, ...subtitles].map(asset => asset.url)).size !== frames.length + subtitles.length
  )
    throw new Error("Asset URLs must be bounded and unique");
  return {
    producer: "bun-video",
    episodeId: options.episodeId,
    source: { url: options.sourceUrl, sha256: episode.source.sha256, bytes: episode.source.bytes },
    video: { width: episode.width, height: episode.height, durationSeconds: episode.durationSeconds },
    frames,
    ...(subtitles.length ? { subtitles } : {}),
  };
}
