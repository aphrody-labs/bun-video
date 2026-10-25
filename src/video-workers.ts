import { join, dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  VideoCatalog,
  defaultVideoCatalogPath,
  type VideoArtifact,
  type VideoJob,
  type VideoJobStatus,
  type VideoSource,
} from "./video-catalog";
import { validateVideoTask, type VideoRenderTask, type VideoRenderResult } from "./video-worker-task";

export interface VideoWorkerEvent {
  type: "queued" | "started" | "completed" | "failed" | "cancelled";
  jobId: string;
  workerId?: string;
}
export interface VideoWorkerContext {
  jobId: string;
  workDirectory: string;
  signal: AbortSignal;
}
export type VideoTaskRunner = (task: VideoRenderTask, context: VideoWorkerContext) => Promise<VideoRenderResult>;
type MaybePromise<T> = T | Promise<T>;
export interface VideoJobCatalog {
  registerSource(input: Parameters<VideoCatalog["registerSource"]>[0]): MaybePromise<VideoSource>;
  addJob(input: Parameters<VideoCatalog["addJob"]>[0]): MaybePromise<VideoJob>;
  updateJob(
    id: string,
    patch: { status: VideoJobStatus; workerId?: string; error?: string; result?: unknown },
  ): MaybePromise<VideoJob>;
  recordArtifact(input: Parameters<VideoCatalog["recordArtifact"]>[0]): MaybePromise<VideoArtifact>;
  close(): MaybePromise<void>;
}
export interface VideoWorkerPoolOptions {
  workers?: number;
  timeoutMs?: number;
  frameWorkerBudget?: number;
  catalog?: VideoJobCatalog;
  workRoot?: string;
  onEvent?: (event: VideoWorkerEvent) => void;
  runner?: VideoTaskRunner;
}
interface PendingTask {
  task: VideoRenderTask;
  id: string;
  directory: string;
  controller: AbortController;
  resolve: (result: VideoRenderResult) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

/** One native Bun process per job keeps browser/Python main-thread owners isolated. */
export async function runVideoTaskProcess(
  task: VideoRenderTask,
  context: VideoWorkerContext,
): Promise<VideoRenderResult> {
  context.signal.throwIfAborted();
  await mkdir(context.workDirectory, { recursive: true });
  const requestFile = join(context.workDirectory, "request.json");
  const resultFile = join(context.workDirectory, "result.json");
  await Bun.write(requestFile, JSON.stringify({ ...task, workDirectory: context.workDirectory }));
  const stdout = Bun.file(join(context.workDirectory, "worker.stdout.log")).writer();
  const stderr = Bun.file(join(context.workDirectory, "worker.stderr.log")).writer();
  let job: { assign(child: Bun.Subprocess): void; terminate(): void; close(): void } | undefined;
  if (process.platform === "win32") {
    const { Job } = await import("bun:windows");
    job = new Job({ killOnClose: true });
  }
  const command = Bun.isStandaloneExecutable
    ? [process.execPath, "--video-worker", requestFile, resultFile]
    : [
        process.execPath,
        Bun.fileURLToPath(new URL("./video-worker-entry.ts", import.meta.url)),
        requestFile,
        resultFile,
      ];
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => {
    if (job) job.terminate();
    else if (child.exitCode === null) child.kill();
  };
  const drain = async (stream: ReadableStream<Uint8Array>, writer: typeof stdout) => {
    for await (const chunk of stream) {
      writer.write(chunk);
      await writer.flush();
    }
  };
  const draining = Promise.allSettled([drain(child.stdout, stdout), drain(child.stderr, stderr)]);
  try {
    job?.assign(child);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    const code = await child.exited;
    await draining;
    context.signal.throwIfAborted();
    if (code !== 0 || !(await Bun.file(resultFile).exists()))
      throw new Error(`Video worker failed (${code}); private evidence: ${resultFile}`);
    const result = await Bun.file(resultFile).json();
    if (result.ok !== true || !result.result)
      throw new Error(`Video worker did not complete; private evidence: ${resultFile}`);
    return result.result as VideoRenderResult;
  } finally {
    context.signal.removeEventListener("abort", abort);
    abort();
    await child.exited;
    await draining;
    await Promise.allSettled([stdout.end(), stderr.end()]);
    job?.close();
  }
}

export class VideoWorkerPool {
  readonly catalog: VideoJobCatalog;
  readonly #ownsCatalog: boolean;
  readonly #options: Required<Pick<VideoWorkerPoolOptions, "workers" | "timeoutMs" | "frameWorkerBudget">> &
    VideoWorkerPoolOptions;
  readonly #pending: PendingTask[] = [];
  readonly #active = new Map<string, PendingTask>();
  readonly #idle = new Set<() => void>();
  #activeFrames = 0;
  #sequence = 0;
  #initializing = 0;
  #closed = false;

  constructor(options: VideoWorkerPoolOptions = {}) {
    const workers = options.workers ?? 2,
      timeoutMs = options.timeoutMs ?? 300000,
      frameWorkerBudget = options.frameWorkerBudget ?? 8;
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4)
      throw new RangeError("Video job workers must be 1..4");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
      throw new RangeError("Job timeout must be 1..3600000 ms");
    if (!Number.isSafeInteger(frameWorkerBudget) || frameWorkerBudget < 1 || frameWorkerBudget > 8)
      throw new RangeError("Frame worker budget must be 1..8");
    this.#options = { ...options, workers, timeoutMs, frameWorkerBudget };
    this.#ownsCatalog = !options.catalog;
    this.catalog = options.catalog ?? new VideoCatalog();
  }

  submit(input: VideoRenderTask, signal?: AbortSignal): Promise<VideoRenderResult> {
    const receipt = this.enqueue(input, signal);
    void receipt.accepted.catch(() => {});
    return receipt.result;
  }

  enqueue(
    input: VideoRenderTask,
    signal?: AbortSignal,
  ): {
    id: string;
    accepted: Promise<void>;
    result: Promise<VideoRenderResult>;
  } {
    if (this.#closed) throw new Error("Video worker pool is closed");
    signal?.throwIfAborted();
    const task = validateVideoTask(structuredClone(input));
    if ((task.frameWorkers ?? 1) > this.#options.frameWorkerBudget)
      throw new RangeError("Task exceeds the frame worker budget");
    const id = crypto.randomUUID();
    const workRoot = this.#options.workRoot ?? join(dirname(defaultVideoCatalogPath()), "jobs");
    const directory = join(resolve(workRoot), id);
    const acceptance = Promise.withResolvers<void>();
    this.#initializing++;
    const result = this.#submitStored(task, id, directory, acceptance, signal);
    void result.then(
      () => {
        this.#initializing--;
        this.#notifyIdle();
      },
      () => {
        this.#initializing--;
        this.#notifyIdle();
      },
    );
    return { id, accepted: acceptance.promise, result };
  }

  async #submitStored(
    task: VideoRenderTask,
    id: string,
    directory: string,
    acceptance: PromiseWithResolvers<void>,
    signal?: AbortSignal,
  ): Promise<VideoRenderResult> {
    // Full URLs, headers and acquired media stay in the private request file.
    try {
      const source = await this.catalog.registerSource({
        privateRef: join(directory, "request.json"),
        kind: task.source.kind === "file" ? "file" : task.source.kind === "capture" ? "capture" : "url",
      });
      await this.catalog.addJob({
        id,
        sourceId: source.id,
        engine: task.engine,
        config: {
          width: task.width,
          height: task.height,
          fps: task.fps,
          durationFrames: task.durationFrames,
          frameWorkers: task.frameWorkers ?? 1,
          requestRef: source.privateRef,
        },
      });
      if (this.#closed || signal?.aborted) {
        await this.catalog.updateJob(id, { status: "cancelled", error: "Cancelled before execution" });
        throw new Error("Video job cancelled");
      }
    } catch (error) {
      acceptance.reject(error);
      throw error;
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort(signal?.reason ?? new Error("Video job cancelled"));
      const index = this.#pending.findIndex(item => item.id === id);
      if (index >= 0) {
        const pending = this.#pending.splice(index, 1)[0]!;
        void Promise.resolve(this.catalog.updateJob(id, { status: "cancelled", error: "Cancelled before execution" }))
          .then(
            () => pending.reject(new Error("Video job cancelled")),
            error => pending.reject(error),
          )
          .finally(() => {
            pending.detach();
            this.#emit({ type: "cancelled", jobId: id });
            this.#notifyIdle();
          });
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const promise = new Promise<VideoRenderResult>((accept, reject) => {
      this.#pending.push({
        task,
        id,
        directory,
        controller,
        resolve: accept,
        reject,
        detach: () => signal?.removeEventListener("abort", abort),
      });
    });
    this.#emit({ type: "queued", jobId: id });
    acceptance.resolve();
    this.#pump();
    return promise;
  }

  #emit(event: VideoWorkerEvent) {
    try {
      this.#options.onEvent?.(event);
    } catch (error) {
      console.error(`Video worker observer failed: ${error instanceof Error ? error.name : "Error"}`);
    }
  }

  #pump() {
    for (let index = 0; index < this.#pending.length && this.#active.size < this.#options.workers;) {
      const next = this.#pending[index]!;
      const frames = next.task.frameWorkers ?? 1;
      if (!next.controller.signal.aborted && this.#activeFrames + frames > this.#options.frameWorkerBudget) {
        index++;
        continue;
      }
      this.#pending.splice(index, 1);
      if (next.controller.signal.aborted) {
        void Promise.resolve(
          this.catalog.updateJob(next.id, { status: "cancelled", error: "Cancelled before execution" }),
        )
          .then(
            () => next.reject(new Error("Video job cancelled")),
            error => next.reject(error),
          )
          .finally(() => {
            next.detach();
            this.#emit({ type: "cancelled", jobId: next.id });
            this.#notifyIdle();
          });
        continue;
      }
      this.#active.set(next.id, next);
      this.#activeFrames += frames;
      void this.#execute(next).finally(() => {
        this.#active.delete(next.id);
        this.#activeFrames -= frames;
        this.#pump();
        this.#notifyIdle();
      });
    }
  }

  async #execute(pending: PendingTask) {
    const workerId = `bun-${++this.#sequence}`;
    const timeout = pending.task.timeoutMs ?? this.#options.timeoutMs;
    const timer = setTimeout(() => pending.controller.abort(new Error("Video job deadline exceeded")), timeout);
    const { task, id, directory, controller } = pending;
    try {
      await this.catalog.updateJob(id, { status: "running", workerId });
      this.#emit({ type: "started", jobId: id, workerId });
      await mkdir(directory, { recursive: true });
      await Bun.write(join(directory, "request.json"), JSON.stringify({ ...task, workDirectory: directory }));
      const result = await (this.#options.runner ?? runVideoTaskProcess)(task, {
        jobId: id,
        workDirectory: directory,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      await this.catalog.recordArtifact({
        jobId: id,
        kind: "video",
        path: result.output,
        sha256: result.sha256,
        metadata: { bytes: result.bytes, frames: result.frames },
      });
      await this.catalog.updateJob(id, {
        status: "completed",
        result: { output: result.output, sha256: result.sha256, bytes: result.bytes, frames: result.frames },
      });
      this.#emit({ type: "completed", jobId: id, workerId });
      pending.resolve(result);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const status = cancelled ? "cancelled" : "failed";
      const evidence = join(directory, "pool-error.json");
      try {
        await mkdir(directory, { recursive: true });
        await Bun.write(
          evidence,
          JSON.stringify({ name: error instanceof Error ? error.name : "Error", message: String(error) }),
        );
        await this.catalog.updateJob(id, { status, error: `${status}; private evidence: ${evidence}` });
      } catch (evidenceError) {
        console.error(
          `Video job evidence unavailable: ${evidenceError instanceof Error ? evidenceError.name : "Error"}`,
        );
      } finally {
        this.#emit({ type: status, jobId: id, workerId });
        pending.reject(new Error(`Video job ${status}; private evidence: ${evidence}`));
      }
    } finally {
      clearTimeout(timer);
      pending.detach();
    }
  }

  #notifyIdle() {
    if (!this.#active.size && !this.#pending.length && !this.#initializing) {
      for (const resolve of this.#idle) resolve();
      this.#idle.clear();
    }
  }

  idle(): Promise<void> {
    if (!this.#active.size && !this.#pending.length && !this.#initializing) return Promise.resolve();
    return new Promise(resolve => this.#idle.add(resolve));
  }

  async close() {
    this.#closed = true;
    for (const pending of [...this.#pending, ...this.#active.values()])
      pending.controller.abort(new Error("Video pool closed"));
    this.#pump();
    await this.idle();
    if (this.#ownsCatalog) await this.catalog.close();
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}
