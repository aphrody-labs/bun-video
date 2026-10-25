import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink, readdir, rename, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import {
  packageEpisodeAssets,
  rehydrateEpisodeVolume,
  type EpisodeAsset,
  type EpisodePackageManifest,
} from "../src/episode-assets";

const hash = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bun-video-rehydrate-"));
  const small = new Uint8Array([10, 20, 30, 40]),
    large = new Uint8Array(2500).map((_, index) => index % 251);
  const data = [small, small, new Uint8Array([50, 60]), large];
  const reference = {
    provider: "local",
    episodeId: "fixture",
    role: "derivative",
    continuity: "dragon-ball-super-anime",
  } as const;
  const assets: EpisodeAsset[] = data.map((bytes, index) => ({
    path: ["first.bin", "duplicate.other", "second.bin", "large.bin"][index]!,
    kind: index === 3 ? "source" : "receipt",
    mime: "application/octet-stream",
    bytes: bytes.length,
    sha256: hash(bytes),
    format: index === 1 ? "other" : "bin",
    reference,
  }));
  for (const [index, asset] of assets.entries()) await Bun.write(join(root, asset.path), data[index]!);
  const manifest: EpisodePackageManifest = {
    schemaVersion: 1,
    producer: "bun-video",
    episode: {
      id: "fixture",
      title: "Fixture",
      source: {
        file: "large.bin",
        sha256: hash(large),
        bytes: large.length,
        provider: "Crunchyroll",
        providerEpisodeId: "fixture",
      },
      durationSeconds: 1,
      fps: { numerator: 1, denominator: 1 },
      width: 1,
      height: 1,
      frameCount: 1,
    },
    assets,
    bundles: [],
    completeness: {
      expectedFrames: 1,
      indexedFrames: 1,
      indexedAssets: assets.length,
      packedAssets: 0,
      imageOwner: "Bun.Image",
      archiveOwner: "Bun.Archive",
      fullyPacked: false,
    },
  };
  await packageEpisodeAssets(root, manifest, 1024);
  return { root, manifest, data };
}
async function cleanup(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("bun-video-rehydrate-"))
    throw new Error("Unsafe fixture cleanup");
  await rm(root, { recursive: true, force: true });
}

test("missing native volumes reproduce original bytes including parts, deduplication and insertion order", async () => {
  const { root, manifest } = await fixture();
  try {
    expect(manifest.assets[0]!.packed).toEqual(manifest.assets[1]!.packed);
    expect(manifest.assets[3]!.parts).toHaveLength(3);
    for (const bundle of manifest.bundles) {
      const path = join(root, bundle.file),
        original = await Bun.file(path).bytes();
      await unlink(path);
      const rebuilt = await rehydrateEpisodeVolume(root, manifest, bundle, { maximumBytes: 1024 });
      expect(rebuilt).toMatchObject({
        created: true,
        status: "rehydrated",
        verified: true,
        sha256: bundle.sha256,
        bytes: bundle.bytes,
      });
      expect(await Bun.file(path).bytes()).toEqual(original);
      expect((await new Bun.Archive(original).files()).size).toBe(bundle.entries);
      expect(await rehydrateEpisodeVolume(root, manifest, bundle, { maximumBytes: 1024 })).toMatchObject({
        created: false,
        status: "existing-verified",
      });
    }
    expect((await readdir(join(root, "package"))).some(name => name.endsWith(".rehydrating"))).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("source and immutable descriptor mismatches are rejected before archive publication", async () => {
  const { root, manifest, data } = await fixture();
  try {
    const bundle = manifest.bundles[0]!,
      path = join(root, bundle.file);
    await unlink(path);
    await Bun.write(join(root, "first.bin"), new Uint8Array([9, 20, 30, 40]));
    await expect(rehydrateEpisodeVolume(root, manifest, bundle)).rejects.toThrow("source SHA-256 mismatch");
    expect(await Bun.file(path).exists()).toBe(false);
    await Bun.write(join(root, "first.bin"), data[0]!);
    const wrong = { ...bundle, sha256: "0".repeat(64) };
    const claimed = { ...manifest, bundles: manifest.bundles.map(item => (item.file === bundle.file ? wrong : item)) };
    await expect(rehydrateEpisodeVolume(root, claimed, wrong)).rejects.toThrow("original SHA-256/size");
    expect(await Bun.file(path).exists()).toBe(false);
    await mkdir(join(root, "foreign"));
    await Bun.write(join(root, "foreign/first.bin"), data[0]!);
    await symlink(
      join(root, "foreign"),
      join(root, "linked-source"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linked = {
      ...manifest,
      assets: manifest.assets.map((asset, index) =>
        index === 0 ? { ...asset, path: "linked-source/first.bin" } : asset,
      ),
    };
    await expect(rehydrateEpisodeVolume(root, linked, bundle)).rejects.toThrow("regular files/directories");
    const escaped = {
      ...manifest,
      assets: manifest.assets.map((asset, index) => (index === 0 ? { ...asset, path: "../first.bin" } : asset)),
    };
    await expect(rehydrateEpisodeVolume(root, escaped, bundle)).rejects.toThrow("Invalid archive source reference");
    expect(await Bun.file(path).exists()).toBe(false);
    const partVolume = manifest.bundles[1]!,
      partPath = join(root, partVolume.file);
    await unlink(partPath);
    const changed = new Uint8Array(data[3]!);
    changed[0] ^= 1;
    await Bun.write(join(root, "large.bin"), changed);
    await expect(rehydrateEpisodeVolume(root, manifest, partVolume)).rejects.toThrow("source SHA-256 mismatch");
    expect(await Bun.file(partPath).exists()).toBe(false);
    expect((await readdir(join(root, "package"))).some(name => name.endsWith(".rehydrating"))).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("appending after a retired volume gap preserves existing ordinals and archives", async () => {
  const { root, manifest } = await fixture();
  try {
    const last = manifest.bundles.at(-1)!,
      oldPath = last.file,
      gapPath = "package/assets-0005.tar.gz";
    await rename(join(root, oldPath), join(root, gapPath));
    last.file = gapPath;
    for (const asset of manifest.assets)
      for (const part of asset.parts ?? []) if (part.volume === oldPath) part.volume = gapPath;
    const retained = await Bun.file(join(root, gapPath)).bytes(),
      added = new Uint8Array([71, 72, 73]);
    await Bun.write(join(root, "added.bin"), added);
    manifest.assets.push({
      ...manifest.assets[0]!,
      path: "added.bin",
      bytes: added.length,
      sha256: hash(added),
      packed: undefined,
    });
    await packageEpisodeAssets(root, manifest, 1024);
    expect(manifest.bundles.at(-1)!.file).toBe("package/assets-0006.tar.gz");
    expect(await Bun.file(join(root, gapPath)).bytes()).toEqual(retained);
    expect(hash(await Bun.file(join(root, gapPath)).bytes())).toBe(last.sha256);
    expect(manifest.completeness.fullyPacked).toBe(true);
  } finally {
    await cleanup(root);
  }
});
