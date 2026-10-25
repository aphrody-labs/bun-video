// SPDX-License-Identifier: Apache-2.0
/** One ordered run of the unified pipeline: each stage is isolated, timed and reported. */
export interface PipelineStage {
  readonly id: string;
  readonly enabled: boolean;
  run(signal: AbortSignal): Promise<string | undefined>;
}

export interface StageReport {
  readonly id: string;
  readonly status: "ok" | "failed" | "skipped";
  readonly detail?: string;
  readonly ms: number;
}

export interface PipelineReport {
  readonly ok: boolean;
  readonly stages: readonly StageReport[];
}

/** Runs stages in order. A failed stage is recorded and the run continues with the next one. */
export async function runPipeline(stages: readonly PipelineStage[], signal?: AbortSignal): Promise<PipelineReport> {
  const reports: StageReport[] = [];
  for (const stage of stages) {
    if (!stage.enabled) {
      reports.push({ id: stage.id, status: "skipped", ms: 0 });
      continue;
    }
    const started = performance.now();
    try {
      signal?.throwIfAborted();
      const detail = await stage.run(signal ?? new AbortController().signal);
      reports.push({
        id: stage.id,
        status: "ok",
        ...(detail ? { detail } : {}),
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.name : "error";
      reports.push({ id: stage.id, status: "failed", detail, ms: Math.round(performance.now() - started) });
    }
  }
  return { ok: reports.every(report => report.status !== "failed"), stages: reports };
}
