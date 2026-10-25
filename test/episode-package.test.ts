import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackEpisodeAssets } from "../src/episode-unpack";
import {
  packageEpisodeAssets,
  indexEpisodeAssets,
  safeAssetPath,
  type EpisodeAsset,
  type EpisodePackageManifest,
} from "../src/episode-assets";

test("episode package paths reject Windows traversal and hidden/private stores", () => {
  for (const value of [
    "../cookie.json",
    "C:/secret",
    "foo\\bar",
    ".secrets/file",
    "foo//bar",
    "./source.mp4",
    "foo/../source.mp4",
    "production-manifest.private.json",
    "metadata/source.PRIVATE.json",
  ])
    expect(safeAssetPath(value)).toBe(false);
  expect(safeAssetPath("frames/frame-000001.png")).toBe(true);
});

test("refresh preserves verified archive references when a recovered index has no mtime cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-package-refresh-test-"));
  try {
    const png = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42IAAAAASUVORK5CYII=",
    );
    await Bun.write(join(root, "frames/frame-000001.png"), png);
    await Bun.write(join(root, "source.mp4"), new Uint8Array([1, 2, 3]));
    await Bun.write(join(root, "production-manifest.private.json"), "private fixture");
    await Bun.write(join(root, "catalogue/frames/index.json"), "separate owner's catalogue");
    await Bun.write(
      join(root, "manifest.json"),
      JSON.stringify({
        id: "fixture",
        title: "Fixture",
        source: {
          file: "source.mp4",
          sha256: new Bun.CryptoHasher("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
          bytes: 3,
        },
        width: 1,
        height: 1,
        durationSeconds: 1,
        fps: { numerator: 1, denominator: 1 },
        frameCount: 1,
        frames: { status: "complete", count: 1 },
      }),
    );
    const packed = await packageEpisodeAssets(root, await indexEpisodeAssets(root));
    expect(packed.assets.map(asset => asset.path)).toEqual(["frames/frame-000001.png", "source.mp4"]);
    for (const asset of packed.assets) delete asset.modifiedAtMs;
    const refreshed = await indexEpisodeAssets(root, packed);
    expect(refreshed.assets.map(asset => asset.packed)).toEqual(packed.assets.map(asset => asset.packed));
    const resumed = await packageEpisodeAssets(root, refreshed);
    expect(resumed.bundles.length).toBe(packed.bundles.length);
    expect(resumed.completeness.fullyPacked).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native compressed archive volumes roundtrip split files and deduplicate byte-identical assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-package-test-"));
  try {
    const small = new Uint8Array([10, 20, 30, 40]),
      large = new Uint8Array(2500).map((_, index) => index % 251);
    const hash = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const reference = {
      provider: "local",
      episodeId: "GE00389313JAJP",
      role: "derivative",
      continuity: "dragon-ball-super-anime",
    } as const;
    const assets: EpisodeAsset[] = [
      {
        path: "first.bin",
        kind: "receipt",
        mime: "application/octet-stream",
        bytes: small.length,
        sha256: hash(small),
        format: "bin",
        reference,
      },
      {
        path: "duplicate.other",
        kind: "receipt",
        mime: "application/octet-stream",
        bytes: small.length,
        sha256: hash(small),
        format: "other",
        reference,
      },
      {
        path: "large.bin",
        kind: "source",
        mime: "application/octet-stream",
        bytes: large.length,
        sha256: hash(large),
        format: "bin",
        reference,
      },
    ];
    await Promise.all([
      Bun.write(join(root, "first.bin"), small),
      Bun.write(join(root, "duplicate.other"), small),
      Bun.write(join(root, "large.bin"), large),
    ]);
    const manifest: EpisodePackageManifest = {
      schemaVersion: 1,
      producer: "bun-video",
      episode: {
        id: "fixture",
        title: "Fixture",
        source: {
          file: "large.bin",
          bytes: large.length,
          sha256: hash(large),
          provider: "Crunchyroll",
          providerEpisodeId: "GE00389313JAJP",
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
    const output = await packageEpisodeAssets(root, manifest, 1024);
    expect(output.completeness.fullyPacked).toBe(true);
    expect(output.assets[0]!.packed).toEqual(output.assets[1]!.packed);
    expect(output.assets[2]!.parts!.length).toBe(3);
    const restored = new Uint8Array(large.length);
    for (const part of output.assets[2]!.parts!) {
      const files = await new Bun.Archive(await Bun.file(join(root, part.volume)).arrayBuffer()).files();
      const bytes = new Uint8Array(await files.get(part.path)!.arrayBuffer());
      restored.set(bytes, part.offset);
    }
    expect(hash(restored)).toBe(hash(large));
    expect(await Bun.file(join(root, "package", "manifest.json")).exists()).toBe(true);
    expect(output.bundles.every(volume => volume.uncompressedBytes <= 1024)).toBe(true);
    const unpacked = join(root, "restored");
    expect(await unpackEpisodeAssets(root, unpacked, output)).toEqual({ reconstructedAssets: 3, verified: true });
    expect(new Uint8Array(await Bun.file(join(unpacked, "duplicate.other")).arrayBuffer())).toEqual(small);
    expect(hash(new Uint8Array(await Bun.file(join(unpacked, "large.bin")).arrayBuffer()))).toBe(hash(large));
    await expect(unpackEpisodeAssets(root, unpacked, output)).rejects.toThrow("empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
