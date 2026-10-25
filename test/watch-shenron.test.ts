import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchCatalogue } from "../src/watch-catalogue";
import { createWatchDelivery, type ShenronAssets } from "../src/watch-shenron";

const fixture = join(import.meta.dir, "../hyperframes/player/tests/perf/fixtures/10-video-grid/sample.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;
const hash = "a".repeat(64);
const assets: ShenronAssets = {
  source: { sha256: hash, bytes: 10 },
  video: { width: 480, height: 270, durationSeconds: 10 },
  frames: [{ path: "frames/frame_0001.png", sha256: hash, bytes: 5, width: 480, height: 270, timecodeSeconds: 1 }],
  subtitles: [{ path: "subtitles/fr.vtt", sha256: hash, bytes: 5, language: "fr" }],
};
const origin = "https://assets.example.com";

describe("watch Shenron delivery", () => {
  test("builds the intake contract from qualified URLs", () => {
    const delivery = createWatchDelivery(assets, {
      episodeId: 7,
      sourceUrl: "https://www.crunchyroll.com/watch/ABC12345",
      publicAssetOrigin: origin,
      assetUrls: path => `${origin}/episodes/7/${path}`,
    });
    expect(delivery).toMatchObject({ producer: "bun-video", episodeId: 7, video: { width: 480 } });
    expect(delivery.frames[0]!.url).toBe(`${origin}/episodes/7/frames/frame_0001.png`);
    expect(delivery.subtitles![0]).toMatchObject({ language: "fr", label: "fr" });
  });

  test("rejects unqualified identifiers, origins and URLs", () => {
    const base = { episodeId: 7, sourceUrl: "https://www.crunchyroll.com/watch/ABC12345", publicAssetOrigin: origin };
    const urls = (path: string) => `${origin}/${path}`;
    expect(() => createWatchDelivery(assets, { ...base, episodeId: 0, assetUrls: urls })).toThrow(
      "numeric wiki episode",
    );
    expect(() =>
      createWatchDelivery(assets, { ...base, publicAssetOrigin: "https://x.r2.dev", assetUrls: urls }),
    ).toThrow("custom-domain");
    expect(() => createWatchDelivery(assets, { ...base, assetUrls: {} })).toThrow("No qualified public URL");
    expect(() =>
      createWatchDelivery(assets, { ...base, assetUrls: path => `https://evil.example.com/${path}` }),
    ).toThrow("differs from its qualified origin");
  });

  test.skipIf(!nativeVideo?.available)("catalogue exports hashed original-size PNGs and delivery.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "watch-shenron-"));
    try {
      await copyFile(fixture, join(root, "ep.mp4"));
      await Bun.write(join(root, "ep.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n");
      const [result] = await watchCatalogue(
        [
          {
            id: "ep001",
            source: join(root, "ep.mp4"),
            episodeId: 42,
            sourceUrl: "https://www.crunchyroll.com/watch/ABC12345",
            subtitleLanguage: "fr",
          },
        ],
        {
          out: join(root, "out"),
          detail: "efficient",
          maxFrames: 4,
          whisper: "none",
          shenron: { publicAssetOrigin: origin, maxFrames: 3 },
        },
      );
      expect(result).toMatchObject({ status: "done", delivery: true });
      const dir = join(root, "out", "ep001", "delivery");
      const delivery = await Bun.file(join(dir, "delivery.json")).json();
      expect(delivery.episodeId).toBe(42);
      expect(delivery.frames.length).toBeLessThanOrEqual(3);
      expect(delivery.subtitles).toHaveLength(1);
      const frame = delivery.frames[0];
      expect([frame.width, frame.height]).toEqual([480, 270]);
      const png = new Uint8Array(await Bun.file(join(dir, "frames", "frame_0001.png")).arrayBuffer());
      expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(new Bun.CryptoHasher("sha256").update(png).digest("hex")).toBe(frame.sha256);
      expect(await Bun.file(join(dir, "subtitles", "fr.vtt")).text()).toContain("Bonjour");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
