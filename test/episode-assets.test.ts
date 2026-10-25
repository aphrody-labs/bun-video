import { expect, test } from "bun:test";
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { mp4 } from "../../../test/js/bun/video/fixture";
import {
  analyzeEpisode,
  compareEpisodeMetadata,
  compressEpisode,
  extractEpisode,
  frameBatchSize,
  frameFile,
  rational,
} from "../scripts/episode-assets";

async function removeFixture(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("bun-video-native-"))
    throw new Error("Refusing cleanup outside the owned episode test directory");
  await rm(root, { recursive: true, force: true });
}

test("episode frame numbering and rational cadence retain the fractional final frame", () => {
  const fps = rational("24000/1001");
  expect(fps).toEqual({ numerator: 24000, denominator: 1001 });
  expect((33511 * fps.denominator) / fps.numerator).toBeCloseTo(1397.6879583333334, 9);
  expect(frameFile(1)).toBe("frame-000001.png");
  expect(frameFile(33511)).toBe("frame-033511.png");
  expect(frameFile(12, "webp")).toBe("frame-000012.webp");
  for (const value of ["0/1", "24/0", "bad", "24.5/1"]) expect(() => rational(value)).toThrow();
  expect(() => frameFile(0)).toThrow();
  expect(() => frameFile(1, "jpg")).toThrow();
  expect(frameBatchSize(1920, 1080)).toBe(8);
  expect(frameBatchSize(3840, 2160)).toBe(2);
  expect(() => frameBatchSize(7680, 4320)).toThrow("64 MiB");
});

test("native preservation rejects FPS, timeline and audio-shape changes", () => {
  const metadata: Bun.Video.Metadata = {
    width: 64,
    height: 48,
    duration: 3003 / 24000,
    codec: "H264",
    container: "MP4",
    fpsNumerator: 24000,
    fpsDenominator: 1001,
    frameCount: 3,
    fileBytes: 1200,
    audioStreams: [],
  };
  expect(() => compareEpisodeMetadata(metadata, { ...metadata, fileBytes: 900 })).not.toThrow();
  for (const changed of [
    { fpsNumerator: 24, fpsDenominator: 1 },
    { frameCount: 2 },
    { width: 32 },
    { duration: metadata.duration! + 0.002 },
    { audioStreams: [{ sampleRate: 48000, channels: 2, codec: "AAC" }] },
  ])
    expect(() => compareEpisodeMetadata(metadata, { ...metadata, ...changed })).toThrow();
});

const available = typeof Bun.Video === "function" && Bun.Video.available;
test.skipIf(!available)(
  "native analysis and MP4 remux use the shared hermetic container fixture",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bun-video-native-episode-"));
    try {
      const bytes = mp4();
      await Bun.write(join(root, "source.mp4"), bytes);
      await analyzeEpisode(root);
      const source = await Bun.file(join(root, "manifest.json")).json();
      expect({ frames: source.frameCount, width: source.width, height: source.height, fps: source.fps }).toEqual({
        frames: 3,
        width: 64,
        height: 48,
        fps: { numerator: 24000, denominator: 1001 },
      });
      expect(source.source.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
      expect(source.analysis.owner).toContain("FilmCraft");
      await compressEpisode(root);
      const manifest = await Bun.file(join(root, "manifest.json")).json();
      expect(manifest.compression).toMatchObject({ file: "compression/episode.mp4", lossless: true, verified: false });
      const written = await Bun.file(join(root, manifest.compression.file)).bytes();
      for (const value of [1, 2, 3]) expect(Buffer.from(written).includes(Buffer.alloc(16, value))).toBe(true);
      compareEpisodeMetadata(
        await new Bun.Video(join(root, "source.mp4")).metadata(),
        await new Bun.Video(join(root, manifest.compression.file)).metadata(),
      );
      await expect(compressEpisode(root)).rejects.toThrow();
      expect(await Bun.file(join(root, manifest.compression.file)).bytes()).toEqual(written);
    } finally {
      await removeFixture(root);
    }
  },
  30000,
);

test.skipIf(!available || !Bun.env.BUN_VIDEO_EPISODE_TEST_SOURCE)(
  "native extraction has an explicit three-frame scope and preserves existing files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bun-video-native-extract-"));
    const source = resolve(Bun.env.BUN_VIDEO_EPISODE_TEST_SOURCE!);
    try {
      // Same-volume test alias: never copies or changes the authorized large source.
      await link(source, join(root, "source.mp4"));
      await analyzeEpisode(root);
      await extractEpisode(root, { frameLimit: 3 });
      const manifest = await Bun.file(join(root, "manifest.json")).json();
      expect(manifest.frames.count).toBe(3);
      expect(manifest.frames.status).toBe(manifest.frameCount === 3 ? "complete" : "partial");
      const first = await new Bun.Image(join(root, "frames", frameFile(1))).metadata();
      expect([first.width, first.height]).toEqual([manifest.width, manifest.height]);
      expect(await Bun.file(join(root, "frames", frameFile(3))).exists()).toBe(true);
      expect(await Bun.file(join(root, "frames", frameFile(4))).exists()).toBe(false);
      await expect(extractEpisode(root, { frameLimit: 3 })).rejects.toThrow("already contains frames");
    } finally {
      await removeFixture(root);
    }
  },
  90000,
);
