import { dirname, join } from "node:path";
import { compareRGBAFrames, type PixelComparison } from "./pixel-verify";
import type { QualificationStatus, VideoCatalog, VideoJob } from "./video-catalog";
import { watchEvidence, type WatchCatalog } from "./video-watch";

type MaybePromise<T> = T | Promise<T>;

export interface VerifyCatalog extends WatchCatalog {
  getJob(id: string): MaybePromise<VideoJob | null>;
  recordQualification(input: Parameters<VideoCatalog["recordQualification"]>[0]): MaybePromise<unknown>;
}

export interface VerifyRenderOptions {
  /** The watch job whose frames are the reference. */
  watchJobId: string;
  /** A rendered video (Remotion, HyperFrames or any other) to compare against that reference. */
  render: string;
  /** Per-channel tolerance (0-255). Default 8: both sides are JPEG round-tripped, so only content differences remain. */
  channelTolerance?: number;
  /** Largest allowed share of pixels over the tolerance. */
  maxDifferingPixelRatio?: number;
  /** Write the report next to the reference frames and record a qualification. Default true. */
  record?: boolean;
}

export interface VerifyRenderReport {
  scope: "watch-reference-frames";
  /** The reference frames are lossy JPEGs, so a pass is approximate and never proves pixel-exact output. */
  approximate: true;
  passed: boolean;
  render: string;
  frames: { index: number; timestampSeconds: number; comparison: PixelComparison }[];
  skipped: { index: number; timestampSeconds: number; reason: string }[];
  evidenceRef: string | null;
}

interface NativeFrame {
  resize(width: number, height: number, options: { fit: "fill" }): NativeFrame;
  jpeg(options: { quality: number }): NativeFrame;
  bytes(): Promise<Uint8Array>;
}
interface NativeVideo {
  frame(seconds: number): NativeFrame;
  metadata(): Promise<{ duration: number | null }>;
}
interface NativeImage {
  rgba(): Promise<{ width: number; height: number; data: Uint8Array }>;
}

/** Compares a render with a watch job's reference frames using native decoding only (no FFmpeg). */
export async function verifyRenderAgainstWatch(
  catalog: VerifyCatalog,
  options: VerifyRenderOptions,
): Promise<VerifyRenderReport> {
  const { Video, Image } = Bun as unknown as {
    Video?: new (input: string) => NativeVideo;
    Image: new (input: Uint8Array) => NativeImage;
  };
  if (!Video) throw new Error("Native Bun.Video provider unavailable in this runtime");
  if (!(await Bun.file(options.render).exists())) throw new Error("Rendered video does not exist");
  const job = await catalog.getJob(options.watchJobId);
  if (!job || job.engine !== "watch") throw new Error("Reference job is not a watch job");
  const evidence = await watchEvidence(catalog, options.watchJobId);
  if (!evidence.frames.length) throw new Error("The watch job has no reference frames");

  const video = new Video(options.render);
  const duration = (await video.metadata()).duration;
  const frames: VerifyRenderReport["frames"] = [];
  const skipped: VerifyRenderReport["skipped"] = [];
  for (const frame of evidence.frames) {
    if (duration !== null && frame.timestampSeconds >= duration) {
      skipped.push({
        index: frame.index,
        timestampSeconds: frame.timestampSeconds,
        reason: "beyond the render duration",
      });
      continue;
    }
    try {
      const reference = await new Image(new Uint8Array(await Bun.file(frame.path).arrayBuffer())).rgba();
      // The reference went through resize and JPEG (quality 80); the candidate takes the same trip so
      // compression noise cancels and only content differences remain.
      const encoded = await video
        .frame(frame.timestampSeconds)
        .resize(reference.width, reference.height, { fit: "fill" })
        .jpeg({ quality: 80 })
        .bytes();
      const candidate = await new Image(encoded).rgba();
      frames.push({
        index: frame.index,
        timestampSeconds: frame.timestampSeconds,
        comparison: compareRGBAFrames(reference.data, candidate.data, {
          width: reference.width,
          height: reference.height,
          channelTolerance: options.channelTolerance ?? 8,
          maxDifferingPixelRatio: options.maxDifferingPixelRatio ?? 0.02,
        }),
      });
    } catch (error) {
      skipped.push({ index: frame.index, timestampSeconds: frame.timestampSeconds, reason: (error as Error).message });
    }
  }
  const passed = frames.length > 0 && skipped.length === 0 && frames.every(f => f.comparison.passed);
  const report: VerifyRenderReport = {
    scope: "watch-reference-frames",
    approximate: true,
    passed,
    render: options.render,
    frames,
    skipped,
    evidenceRef: null,
  };
  if (options.record !== false) {
    const evidenceRef = join(dirname(evidence.frames[0]!.path), `verify-${crypto.randomUUID()}.json`);
    await Bun.write(evidenceRef, JSON.stringify(report, null, 2));
    report.evidenceRef = evidenceRef;
    const status: QualificationStatus = passed ? "passed" : "failed";
    await catalog.recordQualification({
      sourceId: job.sourceId,
      status,
      evidenceRef,
      detail: `Approximate comparison of ${frames.length} watch reference frame(s) (JPEG); not a pixel-exact or playback gate`,
    });
  }
  return report;
}
