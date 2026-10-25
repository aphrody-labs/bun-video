import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoCatalog } from "../src/video-catalog";
import { VideoWorkerPool, type VideoTaskRunner } from "../src/video-workers";
import type { VideoRenderTask, VideoRenderResult } from "../src/video-worker-task";

const root = join(tmpdir(), `bun-video-pool-${crypto.randomUUID()}`);
const task = (number: number): VideoRenderTask => ({
  source: { kind: "file", value: Bun.fileURLToPath(import.meta.url) },
  engine: number % 2 ? "remotion" : "hyperframes",
  output: join(root, `${number}.mp4`),
  width: 320,
  height: 180,
  fps: 30,
  durationFrames: 1,
  frameWorkers: 1,
});
const result = (input: VideoRenderTask): VideoRenderResult => ({
  output: input.output,
  engine: input.engine,
  sourcePath: input.source.value,
  compositionEntry: input.source.value,
  frames: 1,
  sha256: "00".repeat(32),
  bytes: 1,
});

test("job pool limits parallel work and persists independent success/failure", async () => {
  using catalog = new VideoCatalog(":memory:");
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started = Promise.withResolvers<void>();
  let active = 0,
    maximum = 0,
    count = 0;
  const runner: VideoTaskRunner = async input => {
    const index = count++;
    active++;
    maximum = Math.max(active, maximum);
    if (count === 2) started.resolve();
    try {
      await gates[index]!.promise;
      if (input.output === join(root, "2.mp4")) throw new Error("Controlled renderer failure");
      return result(input);
    } finally {
      active--;
    }
  };
  await using pool = new VideoWorkerPool({ catalog, workers: 2, workRoot: root, runner });
  const first = pool.submit(task(1));
  const second = pool.submit(task(2));
  const third = pool.submit(task(3));
  const outcomes = Promise.allSettled([first, second, third]);
  await started.promise;
  expect(count).toBe(2);
  expect(maximum).toBe(2);
  for (const gate of gates) gate.resolve();
  const settled = await outcomes;
  await pool.idle();
  expect(settled.map(value => value.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(catalog.listJobs("completed")).toHaveLength(2);
  expect(catalog.listJobs("failed")).toHaveLength(1);
  expect(catalog.listArtifacts()).toHaveLength(2);
  expect(maximum).toBe(2);
}, 10000);

test("queued cancellation settles immediately without waiting for occupied slot", async () => {
  using catalog = new VideoCatalog(":memory:");
  const gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  await using pool = new VideoWorkerPool({
    catalog,
    workers: 1,
    workRoot: root,
    runner: async input => {
      started.resolve();
      await gate.promise;
      return result(input);
    },
  });
  const first = pool.submit(task(4));
  await started.promise;
  const abort = new AbortController();
  const second = pool.submit(task(5), abort.signal);
  const cancelled = second.catch(error => error);
  abort.abort();
  expect(String(await cancelled)).toContain("cancelled");
  expect(catalog.listJobs("cancelled")).toHaveLength(1);
  gate.resolve();
  await first;
}, 10000);

test("private task URLs stay out of catalog config and caller mutation is isolated", async () => {
  using catalog = new VideoCatalog(":memory:");
  const gate = Promise.withResolvers<void>();
  let received: VideoRenderTask | undefined;
  await using pool = new VideoWorkerPool({
    catalog,
    workers: 1,
    workRoot: root,
    runner: async input => {
      await gate.promise;
      received = input;
      return result(input);
    },
  });
  const input = {
    ...task(6),
    source: { kind: "direct" as const, value: "https://www.crunchyroll.com/?signature=private-test" },
  };
  const pending = pool.submit(input);
  input.source.value = "https://www.crunchyroll.com/";
  gate.resolve();
  await pending;
  expect(received?.source.value).toContain("signature=private-test");
  expect(JSON.stringify(catalog.listJobs())).not.toContain("signature=");
  expect(
    catalog.listSources().every(source => source.url === null && source.privateRef?.endsWith("request.json")),
  ).toBe(true);
}, 10000);

test("frame budget refuses oversized tasks before enqueue", async () => {
  using catalog = new VideoCatalog(":memory:");
  await using pool = new VideoWorkerPool({ catalog, frameWorkerBudget: 1, runner: async input => result(input) });
  expect(() => pool.submit({ ...task(7), frameWorkers: 2 })).toThrow("budget");
  expect(catalog.listJobs()).toHaveLength(0);
});
