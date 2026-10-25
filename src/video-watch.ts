import { dirname, join } from "node:path";
import type { VideoArtifact, VideoCatalog, VideoJob, VideoSource } from "./video-catalog";
import { watch, type Segment, type WatchOptions, type WatchReport } from "./watch";

type MaybePromise<T> = T | Promise<T>;

/** The slice of the SQLite and Neon catalogs a watch job needs. */
export interface WatchCatalog {
  registerSource(input: Parameters<VideoCatalog["registerSource"]>[0]): MaybePromise<VideoSource>;
  addJob(input: Parameters<VideoCatalog["addJob"]>[0]): MaybePromise<VideoJob>;
  updateJob(
    id: string,
    patch: { status: VideoJob["status"]; workerId?: string; error?: string; result?: unknown },
  ): MaybePromise<VideoJob>;
  recordArtifact(input: Parameters<VideoCatalog["recordArtifact"]>[0]): MaybePromise<VideoArtifact>;
  recordFrame(input: Parameters<VideoCatalog["recordFrame"]>[0]): MaybePromise<unknown>;
  listArtifacts(jobId?: string): MaybePromise<VideoArtifact[]>;
  listFrames(jobId: string): MaybePromise<{ frame: number; artifactId: string; timestampMs: number | null }[]>;
}

export interface WatchedVideo {
  jobId: string;
  sourceId: string;
  report: WatchReport;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A registrable reference: a clean public URL, or the local media path (signed URLs never reach the catalog). */
function sourceInput(report: WatchReport): Parameters<WatchCatalog["registerSource"]>[0] {
  try {
    const url = new URL(report.source);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
      return { url: url.href, kind: "url", title: report.title };
  } catch {
    // A local path is not a URL.
  }
  if (!report.localMedia) throw new Error("Cannot record a signed or credentialed URL without its downloaded media");
  return { privateRef: report.localMedia, kind: "file", title: report.title };
}

/** Records one finished watch run as a job with frame, transcript and report artifacts. */
export async function recordWatch(catalog: WatchCatalog, report: WatchReport): Promise<WatchedVideo> {
  const source = await catalog.registerSource(sourceInput(report));
  const job = await catalog.addJob({
    sourceId: source.id,
    engine: "watch",
    config: { detail: report.detail, focus: report.focus, frameEngine: report.frameEngine },
  });
  try {
    await catalog.updateJob(job.id, { status: "running", workerId: "watch" });
    for (const frame of report.frames) {
      const bytes = new Uint8Array(await Bun.file(frame.path).arrayBuffer());
      const artifact = await catalog.recordArtifact({
        jobId: job.id,
        kind: "frame",
        path: frame.path,
        sha256: sha256(bytes),
        metadata: { timestampSeconds: frame.timestampSeconds, reason: frame.reason, bytes: bytes.byteLength },
      });
      await catalog.recordFrame({
        jobId: job.id,
        frame: frame.index,
        artifactId: artifact.id,
        timestampMs: frame.timestampSeconds * 1000,
      });
    }
    const transcriptPath = join(dirname(report.frames[0]?.path ?? join(report.workDir, "x")), "transcript.json");
    const transcript = JSON.stringify({
      source: report.transcriptSource,
      state: report.transcriptState,
      segments: report.transcript,
    });
    await Bun.write(transcriptPath, transcript);
    await catalog.recordArtifact({
      jobId: job.id,
      kind: "transcript",
      path: transcriptPath,
      sha256: sha256(new TextEncoder().encode(transcript)),
      metadata: { segments: report.transcript.length, source: report.transcriptSource, state: report.transcriptState },
    });
    const failed = report.errors.length > 0 && !report.frames.length && !report.transcript.length;
    await catalog.updateJob(job.id, {
      status: failed ? "failed" : "completed",
      error: failed ? report.errors.join("; ") : undefined,
      result: {
        frames: report.frames.length,
        transcriptSegments: report.transcript.length,
        durationSeconds: report.durationSeconds,
        warnings: report.warnings,
        errors: report.errors,
      },
    });
  } catch (error) {
    await catalog.updateJob(job.id, { status: "failed", error: (error as Error).message });
    throw error;
  }
  return { jobId: job.id, sourceId: source.id, report };
}

/** Runs watch and records it in the catalog in one step. */
export async function watchAndRecord(catalog: WatchCatalog, options: WatchOptions): Promise<WatchedVideo> {
  return await recordWatch(catalog, await watch(options));
}

/** Reads a watch job's evidence back from the catalog: ordered frames and the transcript. */
export async function watchEvidence(
  catalog: WatchCatalog,
  jobId: string,
): Promise<{
  frames: { index: number; timestampSeconds: number; path: string; sha256: string | null }[];
  transcript: Segment[];
  transcriptSource: string | null;
}> {
  const [artifacts, rows] = await Promise.all([catalog.listArtifacts(jobId), catalog.listFrames(jobId)]);
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  const frames = rows
    .flatMap(row => {
      const artifact = byId.get(row.artifactId);
      return artifact ? [{ row, artifact }] : [];
    })
    .sort((a, b) => a.row.frame - b.row.frame)
    .map(({ row, artifact }) => ({
      index: row.frame,
      timestampSeconds: (row.timestampMs ?? 0) / 1000,
      path: artifact.path,
      sha256: artifact.sha256,
    }));
  const transcriptArtifact = artifacts.find(artifact => artifact.kind === "transcript");
  const parsed = transcriptArtifact
    ? ((await Bun.file(transcriptArtifact.path).json()) as { source: string | null; segments: Segment[] })
    : { source: null, segments: [] };
  return { frames, transcript: parsed.segments, transcriptSource: parsed.source };
}
