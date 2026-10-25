import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoCatalog } from "../src/video-catalog";
import { UnifiedVideoPipeline } from "../src/video-workflow";

const root = join(import.meta.dir, "../hyperframes");
const reference = join(root, "player/tests/perf/fixtures/10-video-grid/sample.mp4");
const other = join(root, "cli/src/commands/__fixtures__/silent.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;

describe.skipIf(!nativeVideo?.available)("render verification against watch evidence", () => {
  test("passes an identical render, fails a different one, and records both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "video-verify-"));
    const pipeline = new UnifiedVideoPipeline({ catalog: new VideoCatalog(":memory:"), closeCatalog: true });
    try {
      const media = join(dir, "ref.mp4");
      await copyFile(reference, media);
      const watched = await pipeline.watch({
        source: media,
        detail: "efficient",
        maxFrames: 4,
        resolution: 160,
        whisper: "none",
        outDir: dir,
      });

      const same = await pipeline.verifyRender({ watchJobId: watched.jobId, render: media });
      expect(same).toMatchObject({ scope: "watch-reference-frames", approximate: true, passed: true });
      expect(same.frames).toHaveLength(watched.report.frames.length);
      expect(same.skipped).toEqual([]);

      const different = await pipeline.verifyRender({ watchJobId: watched.jobId, render: other });
      expect(different.passed).toBe(false);

      const catalog = pipeline.catalog as VideoCatalog;
      const qualifications = catalog.listQualifications();
      expect(qualifications.map(q => q.status)).toEqual(["passed", "failed"]);
      expect(qualifications[0]!.detail).toContain("Approximate");
      expect(await Bun.file(same.evidenceRef!).exists()).toBe(true);
    } finally {
      await pipeline.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a missing render and a job that is not a watch job", async () => {
    const pipeline = new UnifiedVideoPipeline({ catalog: new VideoCatalog(":memory:"), closeCatalog: true });
    try {
      await expect(pipeline.verifyRender({ watchJobId: "x", render: join(tmpdir(), "missing.mp4") })).rejects.toThrow(
        "does not exist",
      );
      const catalog = pipeline.catalog as VideoCatalog;
      const source = catalog.registerSource({ privateRef: reference });
      const job = catalog.addJob({ sourceId: source.id, engine: "remotion" });
      await expect(pipeline.verifyRender({ watchJobId: job.id, render: reference })).rejects.toThrow("not a watch job");
    } finally {
      await pipeline.close();
    }
  });
});
