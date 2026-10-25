import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeMediaJob } from "../src/media-workflow";

const source = resolve(import.meta.dir, "../hyperframes/cli/src/commands/__fixtures__/silent.mp4");

test.skipIf(!Bun.Video.available)(
  "native media workflow extracts, batches, remuxes and encodes without an external tool",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bun-video-media-workflow-"));
    try {
      const metadata = await new Bun.Video(source).metadata();
      const duration = metadata.duration;
      if (duration === null) throw new Error("Fixture video has no duration metadata");
      expect(duration).toBeGreaterThan(0);

      const framePath = join(directory, "frame.webp");
      const frame = await executeMediaJob({
        action: "extract-frame",
        input: source,
        output: framePath,
        timeSeconds: 0,
        width: 64,
        height: 36,
      });
      expect(frame.bytes).toBeGreaterThan(0);
      expect(await Bun.file(framePath).exists()).toBe(true);
      expect(await new Bun.Image(await Bun.file(framePath).bytes()).metadata()).toMatchObject({
        width: 64,
        height: 36,
      });

      const batchPath = join(directory, "frames");
      const batch = await executeMediaJob({
        action: "extract-frames",
        input: source,
        outputDirectory: batchPath,
        startSeconds: 0,
        endSeconds: duration,
        stepSeconds: duration / 4,
        maxFrames: 4,
      });
      expect(batch.frames).toHaveLength(4);
      expect(batch.totalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(await Bun.file(join(batchPath, "timeline.json")).exists()).toBe(true);

      const remuxPath = join(directory, "copy.mp4");
      const remux = await executeMediaJob({ action: "remux", input: source, output: remuxPath });
      expect(remux.bytes).toBeGreaterThan(0);
      const remuxDuration = (await new Bun.Video(remuxPath).metadata()).duration;
      if (remuxDuration === null) throw new Error("Remuxed fixture has no duration metadata");
      expect(remuxDuration).toBeCloseTo(duration, 1);

      const gifPath = join(directory, "preview.gif");
      const gif = await executeMediaJob({
        action: "gif",
        input: source,
        output: gifPath,
        startSeconds: 0,
        durationSeconds: Math.min(1, duration),
        fps: 4,
        width: 64,
      });
      expect(gif.bytes).toBeGreaterThan(0);
      expect(await Bun.file(gifPath).exists()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("extract-frame rejects non-finite times and oversized pixel allocations", async () => {
  await expect(
    executeMediaJob({ action: "extract-frame", input: source, output: "frame.webp", timeSeconds: Number.NaN }),
  ).rejects.toThrow("Frame time must be non-negative");
  await expect(
    executeMediaJob({
      action: "extract-frame",
      input: source,
      output: "frame.webp",
      timeSeconds: 0,
      width: 16_384,
      height: 16_384,
    }),
  ).rejects.toThrow("64 megapixels");
});
