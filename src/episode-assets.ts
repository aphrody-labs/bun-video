import { readdir, mkdir, rename, appendFile, lstat, realpath, open, link, unlink } from "node:fs/promises";
import { extname, join, isAbsolute, resolve } from "node:path";
import { createVideoArchive } from "./archive";

export type EpisodeAssetKind =
  | "source"
  | "video"
  | "frame"
  | "storyboard"
  | "poster"
  | "gif"
  | "icon"
  | "subtitle"
  | "evidence"
  | "receipt"
  | "document"
  | "dataset"
  | "theme";
export interface EpisodeAsset {
  path: string;
  kind: EpisodeAssetKind;
  mime: string;
  bytes: number;
  sha256: string;
  modifiedAtMs?: number;
  width?: number;
  height?: number;
  frameNumber?: number;
  timecodeSeconds?: number;
  language?: string;
  format?: string;
  title?: string;
  packed?: { volume: string; path: string };
  parts?: Array<{ volume: string; path: string; offset: number; bytes: number; sha256: string }>;
  reference: {
    provider: "local" | "Crunchyroll";
    episodeId: string;
    role: "anime-reference" | "derivative";
    continuity: "dragon-ball-super-anime";
  };
}
export interface EpisodeArchiveVolume {
  file: string;
  bytes: number;
  sha256: string;
  entries: number;
  uncompressedBytes: number;
  compression: "gzip";
  owner: "Bun.Archive";
}
export interface EpisodePackageManifest {
  schemaVersion: 1;
  producer: "bun-video";
  episode: {
    id: string;
    title: string;
    source: { file: string; sha256: string; bytes: number; provider: "Crunchyroll"; providerEpisodeId: string };
    durationSeconds: number;
    fps: { numerator: number; denominator: number };
    width: number;
    height: number;
    frameCount: number;
  };
  assets: EpisodeAsset[];
  bundles: EpisodeArchiveVolume[];
  completeness: {
    expectedFrames: number;
    indexedFrames: number;
    indexedAssets: number;
    packedAssets: number;
    imageOwner: "Bun.Image";
    archiveOwner: "Bun.Archive";
    fullyPacked: boolean;
  };
}

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
  ".ass": "text/x-ssa",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".sha256": "text/plain",
  ".css": "text/css",
  ".wav": "audio/wav",
};
const sha256 = (bytes: ArrayBuffer | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function safeAssetPath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !/[\\:]/.test(path) &&
    !path.includes(String.fromCharCode(0)) &&
    path
      .split("/")
      .every(
        part =>
          !!part && part !== "." && part !== ".." && !part.startsWith(".") && !/(?:^|\.)private(?:\.|$)/i.test(part),
      )
  );
}
export function assetKind(path: string): EpisodeAssetKind {
  if (path === "source.mp4") return "source";
  if (path.startsWith("frames/")) return "frame";
  if (path.startsWith("storyboard/")) return "storyboard";
  if (path.startsWith("icons/evidence/")) return "evidence";
  if (path.startsWith("icons/")) return "icon";
  if (path.startsWith("gifs/")) return "gif";
  if (path.startsWith("subtitles/")) return path.endsWith(".json") ? "receipt" : "subtitle";
  if (path.startsWith("dataset/")) return "dataset";
  if (path.startsWith("themes/")) return "theme";
  if (path.startsWith("compression/") || path.endsWith(".mkv")) return "video";
  if (path.startsWith("poster.")) return "poster";
  return path.endsWith(".md") ? "document" : "receipt";
}

async function atomicJSON(path: string, value: unknown) {
  await Bun.write(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** Image derivatives use the runtime's native Image owner exclusively. */
export async function prepareEpisodeImages(root: string) {
  const manifest = (await Bun.file(join(root, "manifest.json")).json()) as {
    fps: { numerator: number; denominator: number };
    frameCount: number;
    width: number;
    height: number;
    storyboard: Array<{ time: number; file: string }>;
    poster: string;
    highlights: Array<{ poster?: string }>;
  };
  const storyboard = [];
  const replacements = new Map<string, string>();
  for (const entry of manifest.storyboard) {
    const frame = Math.min(
      manifest.frameCount,
      Math.floor((entry.time * manifest.fps.numerator) / manifest.fps.denominator) + 1,
    );
    const input = join(root, "frames", `frame-${String(frame).padStart(6, "0")}.png`);
    const file = `storyboard/frame-${String(entry.time).padStart(4, "0")}.webp`;
    await new Bun.Image(input, { maxPixels: manifest.width * manifest.height })
      .resize(480, 270)
      .webp({ lossless: true })
      .write(join(root, file));
    const metadata = await new Bun.Image(join(root, file)).metadata();
    if (metadata.width !== 480 || metadata.height !== 270 || metadata.format !== "webp")
      throw new Error("Bun.Image derivative has invalid dimensions or codec");
    replacements.set(entry.file, file);
    storyboard.push({ time: entry.time, file });
  }
  const posterFrame = Math.min(
    manifest.frameCount,
    Math.floor((780 * manifest.fps.numerator) / manifest.fps.denominator) + 1,
  );
  await new Bun.Image(join(root, "frames", `frame-${String(posterFrame).padStart(6, "0")}.png`))
    .resize(1280, 720)
    .webp({ lossless: true })
    .write(join(root, "poster.webp"));
  await atomicJSON(join(root, "manifest.json"), {
    ...manifest,
    poster: "poster.webp",
    storyboard,
    highlights: manifest.highlights.map(item => ({
      ...item,
      poster: item.poster ? (replacements.get(item.poster) ?? item.poster) : undefined,
    })),
    imageProcessing: {
      owner: "Bun.Image",
      storyboardFormat: "webp-lossless",
      posterFormat: "webp-lossless",
      sharpUsed: false,
    },
  });
}

async function filesIn(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      !safeAssetPath(path) ||
      ["package", "browser-test", "verification", "catalogue"].includes(path.split("/")[0]!) ||
      path.split("/").some(segment => /(?:^|\.)private(?:\.|$)/i.test(segment)) ||
      path.endsWith(".tmp") ||
      path.endsWith(".log") ||
      path.startsWith("sample.") ||
      path.startsWith("rio-") ||
      path === "contact-sheet.jpg" ||
      (path.startsWith("storyboard/") && path.endsWith(".jpg")) ||
      path === "poster.jpg" ||
      path === "manifest.json"
    )
      continue;
    if (entry.isSymbolicLink()) throw new Error(`Asset symlink rejected: ${path}`);
    if (entry.isDirectory()) files.push(...(await filesIn(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export async function indexEpisodeAssets(
  root: string,
  previous?: EpisodePackageManifest,
): Promise<EpisodePackageManifest> {
  const work = (await Bun.file(join(root, "manifest.json")).json()) as {
    id: string;
    title: string;
    source: { file: string; sha256: string; bytes: number };
    durationSeconds: number;
    fps: { numerator: number; denominator: number };
    width: number;
    height: number;
    frameCount: number;
    frames: { count: number; status: string };
  };
  if (work.frames.status !== "complete" || work.frames.count !== work.frameCount)
    throw new Error("Complete frame extraction is required before asset indexing");
  const assets: EpisodeAsset[] = [];
  const priorAssets = new Map(previous?.assets.map(asset => [asset.path, asset]));
  const episodeId = "GE00389313JAJP";
  let frameCount = 0;
  for (const path of await filesIn(root)) {
    const file = Bun.file(join(root, path)),
      kind = assetKind(path),
      extension = extname(path).toLowerCase();
    const prior = priorAssets.get(path);
    if (
      previous?.episode.source.sha256 === work.source.sha256 &&
      prior?.modifiedAtMs === file.lastModified &&
      prior.bytes === file.size
    ) {
      assets.push(prior);
      continue;
    }
    const hash = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of file.stream()) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const asset: EpisodeAsset = {
      path,
      kind,
      mime: mimeTypes[extension] ?? "application/octet-stream",
      bytes,
      sha256: hash.digest("hex"),
      modifiedAtMs: file.lastModified,
      format: extension.slice(1),
      reference: {
        provider: kind === "source" || (kind === "subtitle" && !path.includes(".asr.")) ? "Crunchyroll" : "local",
        episodeId,
        role:
          kind === "source" || kind === "frame" || (kind === "subtitle" && !path.includes(".asr."))
            ? "anime-reference"
            : "derivative",
        continuity: "dragon-ball-super-anime",
      },
    };
    if ([".png", ".webp", ".jpg", ".jpeg", ".gif"].includes(extension)) {
      const metadata = await new Bun.Image(join(root, path), { maxPixels: 1920 * 1080 }).metadata();
      asset.width = metadata.width;
      asset.height = metadata.height;
    }
    if (kind === "frame") {
      const match = /^frames\/frame-(\d{6})\.png$/.exec(path);
      if (!match || asset.width !== work.width || asset.height !== work.height)
        throw new Error(`Invalid source frame asset: ${path}`);
      asset.frameNumber = Number(match[1]);
      asset.timecodeSeconds = ((asset.frameNumber - 1) * work.fps.denominator) / work.fps.numerator;
      if (++frameCount % 1000 === 0) console.log(JSON.stringify({ stage: "asset-index", frame: asset.frameNumber }));
    }
    if (kind === "subtitle") asset.language = path.includes("ja-JP") ? "ja-JP" : "fr-FR";
    if (prior?.sha256 === asset.sha256 && prior.bytes === asset.bytes) {
      asset.packed = prior.packed;
      asset.parts = prior.parts;
    }
    assets.push(asset);
  }
  const indexedFrames = assets.filter(asset => asset.kind === "frame").length;
  if (indexedFrames !== work.frameCount) throw new Error("Asset index does not cover every extracted frame");
  const result: EpisodePackageManifest = {
    schemaVersion: 1,
    producer: "bun-video",
    episode: { ...work, source: { ...work.source, provider: "Crunchyroll", providerEpisodeId: episodeId } },
    assets,
    bundles: previous?.bundles ?? [],
    completeness: {
      expectedFrames: work.frameCount,
      indexedFrames,
      indexedAssets: assets.length,
      packedAssets: 0,
      imageOwner: "Bun.Image",
      archiveOwner: "Bun.Archive",
      fullyPacked: false,
    },
  };
  // Avoid duplicating private workflow details inside the distribution header.
  result.episode = {
    id: work.id,
    title: work.title,
    source: { ...work.source, provider: "Crunchyroll", providerEpisodeId: episodeId },
    durationSeconds: work.durationSeconds,
    fps: work.fps,
    width: work.width,
    height: work.height,
    frameCount: work.frameCount,
  };
  return result;
}

/** Bounded native tar.gz volumes deduplicate byte-identical assets by SHA-256. */
export async function packageEpisodeAssets(
  root: string,
  input: EpisodePackageManifest,
  maximumVolumeBytes = 64 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(maximumVolumeBytes) || maximumVolumeBytes < 1024 || maximumVolumeBytes > 128 * 1024 * 1024)
    throw new RangeError("Archive volume budget must be 1 KiB..128 MiB");
  const output = join(root, "package");
  await mkdir(output, { recursive: true });
  let entries: Record<string, Uint8Array> = {},
    pending: EpisodeAsset[] = [],
    parts: Array<{ asset: EpisodeAsset; path: string; offset: number; bytes: number; sha256: string }> = [],
    size = 0;
  const packedHashes = new Map(input.assets.filter(asset => asset.packed).map(asset => [asset.sha256, asset.packed!]));
  const pendingPaths = new Map<string, string>();
  const flush = async () => {
    if (!Object.keys(entries).length) return;
    const ordinal =
      input.bundles.reduce((maximum, bundle) => {
        const match = /^package\/assets-(\d+)\.tar\.gz$/.exec(bundle.file);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid archive volume ordinal");
        return Math.max(maximum, Number(match[1]));
      }, 0) + 1;
    const name = `assets-${String(ordinal).padStart(4, "0")}.tar.gz`;
    if (await Bun.file(join(output, name)).exists()) throw new Error("Refusing to replace an existing archive volume");
    const archive = createVideoArchive(entries, "tar.gz", { level: 1, mtime: 0 });
    const bytes = await archive.bytes();
    await Bun.write(join(output, name), bytes);
    const unpacked = await new Bun.Archive(bytes).files();
    if (unpacked.size !== Object.keys(entries).length)
      throw new Error("Archive entry count differs after native roundtrip");
    for (const [path, expected] of Object.entries(entries)) {
      const actual = unpacked.get(path);
      if (!actual || sha256(await actual.arrayBuffer()) !== sha256(expected))
        throw new Error(`Archive roundtrip changed asset: ${path}`);
    }
    input.bundles.push({
      file: `package/${name}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      entries: Object.keys(entries).length,
      uncompressedBytes: size,
      compression: "gzip",
      owner: "Bun.Archive",
    });
    for (const asset of pending) {
      asset.packed = { volume: `package/${name}`, path: pendingPaths.get(asset.sha256)! };
      packedHashes.set(asset.sha256, asset.packed);
    }
    for (const part of parts) {
      part.asset.parts ??= [];
      part.asset.parts.push({
        volume: `package/${name}`,
        path: part.path,
        offset: part.offset,
        bytes: part.bytes,
        sha256: part.sha256,
      });
    }
    await appendFile(
      join(output, "packing-progress.jsonl"),
      `${JSON.stringify({
        volume: input.bundles.at(-1),
        packed: pending.map(asset => ({ path: asset.path, packed: asset.packed })),
        parts: parts.map(part => ({ path: part.asset.path, part: part.asset.parts!.at(-1) })),
      })}\n`,
    );
    console.log(
      JSON.stringify({ stage: "archive", volume: input.bundles.length, bytes: bytes.length, assets: pending.length }),
    );
    entries = {};
    pending = [];
    parts = [];
    size = 0;
    pendingPaths.clear();
  };
  for (const asset of input.assets) {
    if (asset.packed || asset.parts) continue;
    const existing = packedHashes.get(asset.sha256);
    if (existing) {
      asset.packed = existing;
      continue;
    }
    const pendingSame = pending.find(item => item.sha256 === asset.sha256);
    if (pendingSame) {
      pending.push(asset);
      continue;
    }
    const file = Bun.file(join(root, asset.path));
    if (file.size !== asset.bytes) throw new Error(`Asset changed before packaging: ${asset.path}`);
    if (asset.bytes > maximumVolumeBytes) {
      await flush();
      for (let offset = 0; offset < asset.bytes; offset += maximumVolumeBytes) {
        const bytes = new Uint8Array(
          await file.slice(offset, Math.min(asset.bytes, offset + maximumVolumeBytes)).arrayBuffer(),
        );
        const path = `parts/${asset.sha256}/${String(offset).padStart(12, "0")}`;
        entries[path] = bytes;
        size = bytes.length;
        parts.push({ asset, path, offset, bytes: bytes.length, sha256: sha256(bytes) });
        await flush();
      }
      continue;
    }
    if (size + asset.bytes > maximumVolumeBytes) await flush();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sha256(bytes) !== asset.sha256) throw new Error(`Asset changed before packaging: ${asset.path}`);
    const blobPath = `blobs/${asset.sha256}.${asset.format}`;
    entries[blobPath] = bytes;
    pendingPaths.set(asset.sha256, blobPath);
    pending.push(asset);
    size += bytes.length;
  }
  await flush();
  input.completeness.packedAssets = input.assets.filter(asset => asset.packed || asset.parts).length;
  input.completeness.fullyPacked = input.completeness.packedAssets === input.assets.length;
  if (!input.completeness.fullyPacked) throw new Error("Some assets are missing from the archive package");
  await atomicJSON(join(output, "manifest.json"), input);
  await Bun.write(
    join(output, "SHA256SUMS"),
    input.bundles.map(volume => `${volume.sha256}  ${volume.file.slice(8)}`).join("\n") +
      `\n${sha256(await Bun.file(join(output, "manifest.json")).arrayBuffer())}  manifest.json\n`,
  );
  await Bun.write(
    join(output, "README.md"),
    `# Bun Video — ${input.episode.title}\n\n${input.assets.length} assets, ${input.bundles.length} volumes tar.gz natifs, ${input.episode.frameCount} frames.\n\nChaque asset est identifié par chemin, taille, SHA-256, format, dimensions/timestamp et provenance. packed désigne son blob dédupliqué ; parts décrit les morceaux ordonnés des grands fichiers. Les archives ont été relues avec Bun.Archive et chaque contenu a été vérifié par SHA-256. Les dérivés d’image et leurs métadonnées utilisent Bun.Image. Aucun cookie, token ou URL signée n’est inclus.\n\nReconstruction : bun scripts/episode-package.ts unpack <episode-directory> <empty-output-directory>. Le contrat Shenron et la qualification des URLs sont décrits par docs/shenron-episode-assets.md. Les reçus de publication constituent la preuve de livraison R2.\n`,
  );
  const metadata = await createVideoArchive(
    {
      "manifest.json": await Bun.file(join(output, "manifest.json")).arrayBuffer(),
      "SHA256SUMS": await Bun.file(join(output, "SHA256SUMS")).arrayBuffer(),
      "README.md": await Bun.file(join(output, "README.md")).arrayBuffer(),
    },
    "tar.gz",
    { level: 9, mtime: 0 },
  ).bytes();
  const metadataFiles = await new Bun.Archive(metadata).files();
  for (const path of ["manifest.json", "SHA256SUMS", "README.md"])
    if (
      sha256(await metadataFiles.get(path)!.arrayBuffer()) !== sha256(await Bun.file(join(output, path)).arrayBuffer())
    )
      throw new Error("Metadata package changed during native archive roundtrip");
  await Bun.write(join(output, "metadata.tar.gz"), metadata);
  await Bun.write(join(output, "metadata.sha256"), `${sha256(metadata)}  metadata.tar.gz\n`);
  return input;
}

export async function writeEpisodeAssetIndex(root: string, value: EpisodePackageManifest) {
  await mkdir(join(root, "package"), { recursive: true });
  await atomicJSON(join(root, "package", "asset-index.json"), value);
}

export interface EpisodeVolumeRehydration {
  file: string;
  bytes: number;
  sha256: string;
  entries: number;
  uncompressedBytes: number;
  archiveOwner: "Bun.Archive";
  verified: true;
  created: boolean;
  status: "rehydrated" | "existing-verified";
}

/** Rebuild a missing immutable volume, never a new package or an existing file. */
export async function rehydrateEpisodeVolume(
  root: string,
  manifest: EpisodePackageManifest,
  bundle: EpisodeArchiveVolume,
  options: { signal?: AbortSignal; maximumBytes?: number } = {},
): Promise<EpisodeVolumeRehydration> {
  const maximum = options.maximumBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 128 * 1024 * 1024)
    throw new RangeError("Rehydration budget must be 1 KiB..128 MiB");
  const abort = () => options.signal?.throwIfAborted();
  abort();
  const original = manifest.bundles.find(item => item.file === bundle.file);
  if (
    manifest.producer !== "bun-video" ||
    !original ||
    ["bytes", "sha256", "entries", "uncompressedBytes", "compression", "owner"].some(
      key => original[key as keyof EpisodeArchiveVolume] !== bundle[key as keyof EpisodeArchiveVolume],
    ) ||
    !/^package\/assets-\d{4,}\.tar\.gz$/.test(bundle.file) ||
    !safeAssetPath(bundle.file) ||
    !/^[a-f0-9]{64}$/.test(bundle.sha256) ||
    bundle.owner !== "Bun.Archive" ||
    bundle.compression !== "gzip" ||
    !Number.isSafeInteger(bundle.bytes) ||
    bundle.bytes < 1 ||
    bundle.bytes > maximum ||
    !Number.isSafeInteger(bundle.entries) ||
    bundle.entries < 1 ||
    bundle.entries > 100000 ||
    !Number.isSafeInteger(bundle.uncompressedBytes) ||
    bundle.uncompressedBytes < 0 ||
    bundle.uncompressedBytes > maximum
  )
    throw new Error("Invalid immutable archive descriptor");
  const selectedRoot = resolve(root);
  const rootStat = await lstat(selectedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Rehydration root must be a regular directory");
  const canonicalRoot = await realpath(selectedRoot);
  const checkedPath = async (path: string, missingFinal = false) => {
    if (!safeAssetPath(path)) throw new Error("Unsafe rehydration path");
    const segments = path.split("/");
    let current = canonicalRoot;
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!);
      let stat;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (missingFinal && index === segments.length - 1 && (error as { code?: string }).code === "ENOENT")
          return current;
        throw error;
      }
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()))
        throw new Error(`Rehydration requires regular files/directories: ${path}`);
    }
    return current;
  };
  const checkedBytes = async (path: string, sourceBytes: number, offset: number, length: number, expected: string) => {
    abort();
    const absolute = await checkedPath(path),
      before = await lstat(absolute);
    const handle = await open(absolute, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== sourceBytes || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error(`Rehydration source size/identity mismatch: ${path}`);
      await checkedPath(path);
      const data = new Uint8Array(length);
      for (let position = 0; position < length;) {
        abort();
        const { bytesRead } = await handle.read(
          data,
          position,
          Math.min(1024 * 1024, length - position),
          offset + position,
        );
        if (!bytesRead) throw new Error(`Truncated rehydration source: ${path}`);
        position += bytesRead;
      }
      if (sha256(data) !== expected) throw new Error(`Rehydration source SHA-256 mismatch: ${path}`);
      return data;
    } finally {
      await handle.close();
    }
  };
  const receipt = (created: boolean): EpisodeVolumeRehydration => ({
    file: bundle.file,
    bytes: bundle.bytes,
    sha256: bundle.sha256,
    entries: bundle.entries,
    uncompressedBytes: bundle.uncompressedBytes,
    archiveOwner: "Bun.Archive",
    verified: true,
    created,
    status: created ? "rehydrated" : "existing-verified",
  });
  const destination = await checkedPath(bundle.file, true);
  try {
    await lstat(destination);
    await checkedBytes(bundle.file, bundle.bytes, 0, bundle.bytes, bundle.sha256);
    return receipt(false);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  type Reference = { asset: EpisodeAsset; offset: number; bytes: number; sha256: string };
  const references = new Map<string, Reference>();
  let uncompressed = 0;
  const add = (path: string, ref: Reference) => {
    if (
      !safeAssetPath(path) ||
      !safeAssetPath(ref.asset.path) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !/^[a-f0-9]{64}$/.test(ref.asset.sha256) ||
      !Number.isSafeInteger(ref.asset.bytes) ||
      ref.asset.bytes < 0 ||
      !Number.isSafeInteger(ref.offset) ||
      ref.offset < 0 ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 0 ||
      ref.bytes > maximum ||
      ref.offset + ref.bytes > ref.asset.bytes
    )
      throw new Error("Invalid archive source reference");
    const previous = references.get(path);
    if (previous) {
      if (previous.bytes !== ref.bytes || previous.sha256 !== ref.sha256)
        throw new Error("Conflicting deduplicated archive reference");
      return;
    }
    uncompressed += ref.bytes;
    if (uncompressed > maximum) throw new Error("Rehydration entry budget exceeded");
    references.set(path, ref);
  };
  // Map insertion order matches the original packer's first asset for each blob.
  for (const asset of manifest.assets) {
    if (asset.packed?.volume === bundle.file)
      add(asset.packed.path, { asset, offset: 0, bytes: asset.bytes, sha256: asset.sha256 });
    for (const part of asset.parts ?? []) {
      if (part.volume === bundle.file)
        add(part.path, { asset, offset: part.offset, bytes: part.bytes, sha256: part.sha256 });
    }
  }
  if (references.size !== bundle.entries || uncompressed !== bundle.uncompressedBytes)
    throw new Error("Archive references differ from immutable entry count/size");
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const [path, ref] of references)
    entries[path] = await checkedBytes(ref.asset.path, ref.asset.bytes, ref.offset, ref.bytes, ref.sha256);
  abort();
  const compressed = await createVideoArchive(entries, "tar.gz", { level: 1, mtime: 0 }).bytes();
  if (compressed.length !== bundle.bytes || sha256(compressed) !== bundle.sha256)
    throw new Error(`Rehydrated archive does not match original SHA-256/size: ${bundle.file}`);
  abort();
  await checkedPath(bundle.file, true);
  const temporaryPath = `${bundle.file}.${crypto.randomUUID()}.rehydrating`;
  const temporary = await checkedPath(temporaryPath, true);
  const writer = await open(temporary, "wx");
  try {
    try {
      await writer.writeFile(compressed);
      await writer.sync();
    } finally {
      await writer.close();
    }
    abort();
    await checkedPath(bundle.file, true);
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      await checkedBytes(bundle.file, bundle.bytes, 0, bundle.bytes, bundle.sha256);
      return receipt(false);
    }
    return receipt(true);
  } finally {
    await unlink(temporary);
  }
}
