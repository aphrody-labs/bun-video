import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeAssetPath, type EpisodeAsset, type EpisodePackageManifest } from "./episode-assets";

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Reconstruct a complete package, one bounded native archive volume at a time. */
export async function unpackEpisodeAssets(root: string, output: string, manifest: EpisodePackageManifest) {
  if (manifest.producer !== "bun-video" || !manifest.completeness.fullyPacked)
    throw new Error("A complete Bun Video package is required");
  if (resolve(root) === resolve(output)) throw new Error("Output must differ from package source");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Output directory must be empty");
  const references = new Map<
    string,
    Array<{ asset: EpisodeAsset; offset?: number; bytes?: number; sha256?: string }>
  >();
  const writers = new Map<
    string,
    { sink: ReturnType<Bun.BunFile["writer"]>; offset: number; hash: Bun.CryptoHasher }
  >();
  const complete = new Set<string>();
  for (const asset of manifest.assets) {
    if (
      !safeAssetPath(asset.path) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error("Invalid package asset");
    const refs = asset.packed ? [{ ...asset.packed }] : (asset.parts ?? []);
    if (!refs.length) throw new Error(`Missing archive reference: ${asset.path}`);
    for (const ref of refs) {
      if (!safeAssetPath(ref.volume) || !safeAssetPath(ref.path)) throw new Error("Invalid archive reference");
      const key = `${ref.volume}:${ref.path}`;
      const list = references.get(key) ?? [];
      list.push({ asset, ...("offset" in ref ? { offset: ref.offset, bytes: ref.bytes, sha256: ref.sha256 } : {}) });
      references.set(key, list);
    }
  }
  try {
    for (const volume of manifest.bundles) {
      if (!safeAssetPath(volume.file) || volume.bytes > 256 * 1024 * 1024) throw new Error("Invalid archive volume");
      const file = Bun.file(join(root, volume.file));
      if (file.size !== volume.bytes) throw new Error(`Archive size mismatch: ${volume.file}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (digest(bytes) !== volume.sha256) throw new Error(`Archive hash mismatch: ${volume.file}`);
      const files = await new Bun.Archive(bytes).files();
      if (files.size !== volume.entries) throw new Error("Archive entry count mismatch");
      for (const [path, blob] of files) {
        const refs = references.get(`${volume.file}:${path}`);
        if (!refs) throw new Error("Archive entry is not referenced by package manifest");
        const content = new Uint8Array(await blob.arrayBuffer());
        const hash = digest(content);
        for (const ref of refs) {
          const asset = ref.asset;
          await mkdir(dirname(join(output, asset.path)), { recursive: true });
          if (ref.offset === undefined) {
            if (content.length !== asset.bytes || hash !== asset.sha256 || complete.has(asset.path))
              throw new Error(`Asset content mismatch: ${asset.path}`);
            if ((await Bun.write(join(output, asset.path), content)) !== asset.bytes)
              throw new Error("Incomplete asset write");
            complete.add(asset.path);
          } else {
            if (ref.bytes !== content.length || ref.sha256 !== hash) throw new Error("Split asset part mismatch");
            let writer = writers.get(asset.path);
            if (!writer) {
              if (writers.size >= 16) throw new Error("Too many interleaved split assets");
              writer = {
                sink: Bun.file(join(output, asset.path)).writer(),
                offset: 0,
                hash: new Bun.CryptoHasher("sha256"),
              };
              writers.set(asset.path, writer);
            }
            if (ref.offset !== writer.offset || writer.offset + content.length > asset.bytes)
              throw new Error("Split asset parts are out of order");
            writer.sink.write(content);
            await writer.sink.flush();
            writer.hash.update(content);
            writer.offset += content.length;
            if (writer.offset === asset.bytes) {
              await writer.sink.end();
              writers.delete(asset.path);
              if (writer.hash.digest("hex") !== asset.sha256 || Bun.file(join(output, asset.path)).size !== asset.bytes)
                throw new Error("Reconstructed asset hash or size mismatch");
              complete.add(asset.path);
            }
          }
        }
      }
    }
    if (writers.size || complete.size !== manifest.assets.length)
      throw new Error("Package reconstruction is incomplete");
    return { reconstructedAssets: complete.size, verified: true as const };
  } finally {
    for (const writer of writers.values()) await writer.sink.end();
  }
}
