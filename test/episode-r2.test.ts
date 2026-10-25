import { expect, test } from "bun:test";
import type { EpisodePackageManifest } from "../src/episode-assets";
import {
  directEpisodeAssets,
  episodePrefix,
  normalizeETag,
  publicEpisodeManifest,
  r2Origin,
} from "../scripts/episode-r2";

function fixture(count = 1000): EpisodePackageManifest {
  return {
    schemaVersion: 1,
    producer: "bun-video",
    episode: {
      id: "fixture",
      title: "Reference",
      source: {
        file: "source.mp4",
        bytes: 10,
        sha256: "a".repeat(64),
        provider: "Crunchyroll",
        providerEpisodeId: "GE00389313JAJP",
      },
      width: 32,
      height: 32,
      frameCount: count,
      durationSeconds: 1397.688,
      fps: { numerator: 24000, denominator: 1001 },
    },
    assets: Array.from({ length: count }, (_, index) => ({
      path: `frames/frame-${String(index + 1).padStart(6, "0")}.png`,
      kind: "frame",
      mime: "image/png",
      sha256: "b".repeat(64),
      bytes: 100,
      width: 32,
      height: 32,
      frameNumber: index + 1,
      reference: {
        provider: "local",
        episodeId: "GE00389313JAJP",
        role: "anime-reference",
        continuity: "dragon-ball-super-anime",
      },
      packed: { volume: "package/assets-0001.tar.gz", path: `blobs/${index}.png` },
    })),
    bundles: [
      {
        file: "package/assets-0001.tar.gz",
        bytes: 100,
        sha256: "c".repeat(64),
        entries: count,
        uncompressedBytes: count * 100,
        compression: "gzip",
        owner: "Bun.Archive",
      },
    ],
    completeness: {
      expectedFrames: count,
      indexedFrames: count,
      indexedAssets: count,
      packedAssets: count,
      imageOwner: "Bun.Image",
      archiveOwner: "Bun.Archive",
      fullyPacked: true,
    },
  };
}

test("R2 staging uses the exact source identity and a configured custom domain", () => {
  expect(episodePrefix("a".repeat(64))).toBe(`media/episodes/875/${"a".repeat(64)}/`);
  expect(() => episodePrefix("not-a-sha")).toThrow();
  expect(r2Origin("https://media.example.com/")).toBe("https://media.example.com");
  for (const value of ["http://media.example.com", "https://bucket.r2.dev", "https://media.example.com/?token=secret"])
    expect(() => r2Origin(value)).toThrow();
  expect(normalizeETag('"0123456789ABCDEF0123456789ABCDEF"')).toBe("0123456789abcdef0123456789abcdef");
});

test("public manifest allowlist excludes local absolute paths and protected data", () => {
  const input = fixture(3);
  Object.assign(input.episode.source, { absoluteFile: "C:\\private\\source.mp4", cookie: "must-not-export" });
  Object.assign(input.assets[0]!, { modifiedAtMs: 1234, headers: { Authorization: "must-not-export" } });
  const text = JSON.stringify(publicEpisodeManifest(input));
  expect(text).not.toContain("private");
  expect(text).not.toContain("must-not-export");
  expect(text).not.toContain("modifiedAtMs");
  expect(text).toContain("source.mp4");
  input.assets[0]!.packed!.volume = "C:\\private\\archive.tar.gz";
  expect(() => publicEpisodeManifest(input)).toThrow("Unsafe");
});

test("uniform and annotated frame union avoids full-sequence direct duplication", () => {
  const input = fixture();
  const selected = directEpisodeAssets(input, [3, 3, 17, 999]);
  const numbers = selected.map(frame => frame.frameNumber);
  expect(numbers).toContain(1);
  expect(numbers).toContain(1000);
  expect(numbers).toContain(3);
  expect(numbers).toContain(17);
  expect(new Set(numbers).size).toBe(numbers.length);
  expect(numbers.length).toBeLessThanOrEqual(244);
  expect(input.assets.length).toBe(1000);
  expect(() =>
    directEpisodeAssets(
      input,
      Array.from({ length: 601 }, (_, index) => index + 1),
    ),
  ).toThrow("600-frame");
  expect(() => directEpisodeAssets(input, [1001])).toThrow("Invalid selected");
});
