import { describe, expect, test } from "bun:test";
import { VideoCatalog } from "../src/video-catalog";

describe("private video catalog", () => {
  test("tracks worker lifecycle, artifacts and actual qualification independently", () => {
    using catalog = new VideoCatalog(":memory:");
    const source = catalog.registerSource({ url: "https://www.crunchyroll.com/" });
    const job = catalog.addJob({ sourceId: source.id, engine: "remotion", config: { fps: 30 } });
    expect(job.status).toBe("queued");
    expect(catalog.updateJob(job.id, { status: "running", workerId: "worker-1" }).workerId).toBe("worker-1");
    const artifact = catalog.recordArtifact({
      jobId: job.id,
      kind: "frame",
      path: "private/000.png",
      metadata: { width: 1920 },
    });
    catalog.recordFrame({ jobId: job.id, frame: 0, artifactId: artifact.id });
    catalog.updateJob(job.id, { status: "completed", result: { frames: 1 } });
    expect(catalog.getJob(job.id)?.result).toEqual({ frames: 1 });
    expect(catalog.listArtifacts(job.id)[0]?.metadata).toEqual({ width: 1920 });
    expect(catalog.listQualifications()).toHaveLength(0);
    catalog.recordQualification({ sourceId: source.id, status: "passed", evidenceRef: "private/probe.json" });
    expect(catalog.listQualifications(source.id)[0]?.status).toBe("passed");
  });
  test("enforces references and keeps signed URLs in protected stores", () => {
    using catalog = new VideoCatalog(":memory:");
    expect(() => catalog.registerSource({ url: "https://www.crunchyroll.com/?token=private" })).toThrow(
      "protected file",
    );
    expect(() => catalog.addJob({ sourceId: "missing", engine: "hyperframes" })).toThrow();
    const source = catalog.registerSource({ privateRef: "private/source.json" });
    const one = catalog.addJob({ sourceId: source.id, engine: "hyperframes" });
    const two = catalog.addJob({ sourceId: source.id, engine: "remotion" });
    const artifact = catalog.recordArtifact({ jobId: one.id, kind: "png", path: "private/frame.png" });
    expect(() => catalog.recordFrame({ jobId: two.id, frame: 0, artifactId: artifact.id })).toThrow("same job");
    expect(() => catalog.updateJob("missing", { status: "failed" })).toThrow("Unknown");
  });
  test("imports real APIs and extractor metadata without claiming site success", async () => {
    using catalog = new VideoCatalog(":memory:");
    expect(await catalog.seedCapabilities()).toBeGreaterThan(30);
    const first = catalog.listCapabilities().length;
    await catalog.seedCapabilities();
    expect(catalog.listCapabilities()).toHaveLength(first);
    expect(await catalog.importYtDlpProviders()).toBeGreaterThan(1000);
    expect(catalog.listProviders().every(row => row.status === "not_tested")).toBe(true);
    expect(catalog.listCapabilities().some(row => row.exportName === "extractYtDlp")).toBe(true);
  });
});
