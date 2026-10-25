import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EpisodePackageManifest as AssetManifest } from "../src/episode-assets";
import {
  createShenronEpisodeDelivery,
  createShenronEpisodeDraft,
  selectShenronEpisodeFrames,
} from "../src/shenron-episode";

function fixture(count = 3): AssetManifest {
  const reference = {
    provider: "Crunchyroll" as const,
    episodeId: "GE00389313JAJP",
    role: "anime-reference" as const,
    continuity: "dragon-ball-super-anime" as const,
  };
  return {
    schemaVersion: 1,
    producer: "bun-video",
    episode: {
      id: "fixture",
      title: "Le dieu de la Destruction",
      source: {
        file: "source.mp4",
        sha256: "a".repeat(64),
        bytes: 10,
        provider: "Crunchyroll",
        providerEpisodeId: "GE00389313JAJP",
      },
      width: 32,
      height: 32,
      durationSeconds: 1397.688,
      frameCount: count,
      fps: { numerator: 24000, denominator: 1001 },
    },
    assets: [
      ...Array.from({ length: count }, (_, index) => ({
        path: `frames/frame-${String(index + 1).padStart(6, "0")}.png`,
        kind: "frame" as const,
        mime: "image/png",
        bytes: 100,
        sha256: "b".repeat(64),
        width: 32,
        height: 32,
        frameNumber: index + 1,
        format: "png",
        reference,
      })),
      {
        path: "subtitles/fr.vtt",
        kind: "subtitle",
        mime: "text/vtt",
        bytes: 100,
        sha256: "c".repeat(64),
        language: "fr",
        reference,
      },
    ],
    bundles: [],
    completeness: {
      expectedFrames: count,
      indexedFrames: count,
      indexedAssets: count + 1,
      packedAssets: 0,
      imageOwner: "Bun.Image",
      archiveOwner: "Bun.Archive",
      fullyPacked: false,
    },
  };
}

function options(manifest: AssetManifest) {
  return {
    episodeId: 123,
    sourceUrl: "https://www.crunchyroll.com/watch/GE00389313JAJP",
    publicAssetOrigin: "https://assets.example.com",
    assetUrls: Object.fromEntries(
      manifest.assets.map(asset => [asset.path, `https://assets.example.com/episode/${asset.path}`]),
    ),
  };
}

test("local research draft retains exact timing without inventing wiki IDs or canon", () => {
  const manifest = fixture();
  const result = createShenronEpisodeDraft(manifest);
  expect(result.status).toBe("local-draft");
  expect(result.episode.canonVerdict).toBeNull();
  expect(result.video.durationSeconds).toBe(1397.688);
  expect(result.frameSelection[2]!.timecodeSeconds).toBe((2 * 1001) / 24000);
  expect(result).not.toHaveProperty("episodeId");
  expect(result.ingestionPerformed).toBe(false);
  expect(result.publicationPerformed).toBe(false);
});

test("consumer selection is bounded while retaining first and final reference frames", () => {
  const manifest = fixture(1000);
  const frames = selectShenronEpisodeFrames(manifest, 240);
  expect(frames).toHaveLength(240);
  expect(frames[0]!.frameNumber).toBe(1);
  expect(frames.at(-1)!.frameNumber).toBe(1000);
  expect(new Set(frames.map(frame => frame.frameNumber)).size).toBe(240);
  expect(manifest.assets.filter(asset => asset.kind === "frame")).toHaveLength(1000);
  expect(() => selectShenronEpisodeFrames(manifest, 601)).toThrow();
});

test("delivery excludes derivatives and requires explicitly qualified public artifact URLs", () => {
  const manifest = fixture();
  const delivery = createShenronEpisodeDelivery(manifest, options(manifest));
  expect(delivery.producer).toBe("bun-video");
  expect(delivery.frames).toHaveLength(3);
  expect(delivery.frames[0]!.timecodeSeconds).toBe(0);
  expect(delivery.subtitles?.[0]?.language).toBe("fr");
  expect(() => createShenronEpisodeDelivery(manifest, { ...options(manifest), assetUrls: {} })).toThrow("No qualified");
  expect(() => createShenronEpisodeDelivery(manifest, { ...options(manifest), episodeId: 0 })).toThrow("wiki");
  expect(() =>
    createShenronEpisodeDelivery(manifest, { ...options(manifest), publicAssetOrigin: "https://bucket.r2.dev" }),
  ).toThrow("custom-domain");
  const signed = options(manifest);
  signed.assetUrls[manifest.assets[0]!.path] += "?token=protected";
  expect(() => createShenronEpisodeDelivery(manifest, signed)).toThrow("query data");
});

const shenronRoot = Bun.env.BUN_VIDEO_SHENRON_ROOT;
test.skipIf(!shenronRoot)("producer output passes the live configured Shenron intake owner", async () => {
  const source = resolve(join(shenronRoot!, "packages/media/src/episode-video-delivery.ts"));
  const consumer = await import(pathToFileURL(source).href);
  const manifest = fixture();
  const expected = options(manifest);
  const delivery = createShenronEpisodeDelivery(manifest, expected);
  const result = consumer.episodeVideoPatch(delivery, {
    episodeId: expected.episodeId,
    sourceUrl: expected.sourceUrl,
    sourceSha256: manifest.episode.source.sha256,
    publicAssetOrigin: expected.publicAssetOrigin,
  });
  expect(result.episodeId).toBe(123);
  expect(result.patch.durationSec).toBe(1397);
  expect(result.patch.frames).toHaveLength(3);
  expect(result.patch.subtitles[0].lang).toBe("fr");
  expect(result.provenance.video.durationSeconds).toBe(1397.688);
});
