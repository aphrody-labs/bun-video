import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoCatalog } from "../src/video-catalog";
import { UnifiedVideoPipeline } from "../src/video-workflow";
import { cleanWatch } from "../src/watch";

const fixture = join(import.meta.dir, "../hyperframes/player/tests/perf/fixtures/10-video-grid/sample.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;

describe.skipIf(!nativeVideo?.available)("watch in the unified pipeline", () => {
  test("records frames, transcript and job state, then reads them back", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-watch-"));
    const pipeline = new UnifiedVideoPipeline({ catalog: new VideoCatalog(":memory:"), closeCatalog: true });
    try {
      const media = join(root, "ep.mp4");
      await copyFile(fixture, media);
      await Bun.write(join(root, "ep.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSalut\n");
      const watched = await pipeline.watch({
        source: media,
        detail: "efficient",
        maxFrames: 5,
        resolution: 96,
        whisper: "none",
        outDir: root,
      });
      const catalog = pipeline.catalog as VideoCatalog;
      const job = catalog.getJob(watched.jobId)!;
      expect(job).toMatchObject({ engine: "watch", status: "completed", workerId: "watch" });
      expect((job.result as { frames: number }).frames).toBe(watched.report.frames.length);
      expect(catalog.listSources()[0]).toMatchObject({ privateRef: media, kind: "file" });
      expect(catalog.listArtifacts(watched.jobId).filter(a => a.kind === "frame")).toHaveLength(
        watched.report.frames.length,
      );

      const evidence = await pipeline.watchEvidence(watched.jobId);
      expect(evidence.frames.map(f => f.index)).toEqual(watched.report.frames.map(f => f.index));
      expect(evidence.frames[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.frames.map(f => f.timestampSeconds)).toEqual(watched.report.frames.map(f => f.timestampSeconds));
      expect(evidence.transcript).toEqual([{ start: 1, end: 2, text: "Salut" }]);
      expect(evidence.transcriptSource).toContain("captions");
      await cleanWatch(watched.report);
    } finally {
      await pipeline.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks the job failed when no evidence exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-watch-"));
    const pipeline = new UnifiedVideoPipeline({ catalog: new VideoCatalog(":memory:"), closeCatalog: true });
    try {
      const broken = join(root, "bad.mp4");
      await Bun.write(broken, "not a video");
      const watched = await pipeline.watch({ source: broken, detail: "transcript", whisper: "none", outDir: root });
      const job = (pipeline.catalog as VideoCatalog).getJob(watched.jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toBeTruthy();
    } finally {
      await pipeline.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!nativeVideo?.available)("watch as a media job", () => {
  test("executeMediaJob runs watch with the shared options", async () => {
    const { executeMediaJob } = await import("../src/media-workflow");
    const result = await executeMediaJob({
      action: "watch",
      source: fixture,
      options: { detail: "efficient", maxFrames: 3, resolution: 64, whisper: "none" },
    });
    if (result.action !== "watch" || !result.report) throw new Error("Watch job returned no report");
    const report = result.report;
    try {
      expect(result.action).toBe("watch");
      expect(report.frames.length).toBeGreaterThan(0);
      expect(report.frames.length).toBeLessThanOrEqual(3);
    } finally {
      await cleanWatch(report);
    }
  });
});
