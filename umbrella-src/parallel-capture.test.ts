import { expect, test } from "bun:test";
import { captureParallelFrames, type CaptureWorker, type CaptureWorkerFactory } from "../src/parallel-capture";
import type { FramePlan } from "../src/frame-plan";
import { validateFramePlan } from "../src/frame-plan";

const plan: FramePlan = {
  kind: "hyperframes",
  compositionUrl: "http://localhost/composition",
  fps: { num: 30, den: 1 },
  startFrame: 0,
  endFrame: 6,
  width: 16,
  height: 16,
  workers: 2,
  timeoutMs: 1000,
};
function png() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 16);
  view.setUint32(20, 16);
  return bytes.buffer;
}
class FakeWorker implements CaptureWorker {
  listeners = new Map<string, ((event: any) => void)[]>();
  assigned?: FramePlan & { frameStride: number };
  frame = 0;
  emitted: number[] = [];
  terminated = false;
  constructor(readonly mode: "normal" | "close" | "duplicate" | "stall" | "badPng" = "normal") {}
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  postMessage(value: unknown) {
    const message = value as { type: string; plan?: FramePlan & { frameStride: number } };
    if (message.type === "capture") {
      this.assigned = message.plan!;
      this.frame = this.assigned.startFrame;
    } else this.frame += this.assigned!.frameStride;
    if (this.mode === "stall") return;
    if (this.frame >= this.assigned!.endFrame) {
      this.emit("message", { data: { type: "done" } });
      return;
    }
    this.emitted.push(this.frame);
    this.emit("message", {
      data: {
        type: "frame",
        frame: this.frame,
        png: this.mode === "badPng" ? new ArrayBuffer(33) : png(),
      },
    });
    if (this.mode === "close") this.emit("close");
    if (this.mode === "duplicate") this.emit("message", { data: { type: "frame", frame: this.frame, png: png() } });
  }
  terminate() {
    this.terminated = true;
  }
}
function factory(mode: FakeWorker["mode"] = "normal") {
  const workers: FakeWorker[] = [];
  const create: CaptureWorkerFactory = () => {
    const worker = new FakeWorker(mode);
    workers.push(worker);
    return worker;
  };
  return { workers, create };
}

test("strided capture remains parallel with one outstanding frame per worker", async () => {
  const { workers, create } = factory();
  const iterator = captureParallelFrames(plan, undefined, create);
  expect((await iterator.next()).value?.frame).toBe(0);
  expect(workers.map(worker => worker.emitted)).toEqual([[0], [1]]);
  expect((await iterator.next()).value?.frame).toBe(1);
  expect(workers.map(worker => worker.emitted)).toEqual([[0, 2], [1]]);
  const remaining: number[] = [];
  for await (const item of iterator) remaining.push(item.frame);
  expect(remaining).toEqual([2, 3, 4, 5]);
  expect(workers.map(worker => worker.emitted)).toEqual([
    [0, 2, 4],
    [1, 3, 5],
  ]);
  expect(workers.every(worker => worker.terminated)).toBe(true);
});

for (const mode of ["close", "duplicate", "badPng"] as const) {
  test(`capture rejects ${mode} without waiting for missing frames`, async () => {
    const { workers, create } = factory(mode);
    await expect(captureParallelFrames(plan, undefined, create).next()).rejects.toThrow();
    expect(workers.every(worker => worker.terminated)).toBe(true);
  });
}

test("stalled worker times out per operation and terminates", async () => {
  const { workers, create } = factory("stall");
  await expect(captureParallelFrames({ ...plan, timeoutMs: 10 }, undefined, create).next()).rejects.toThrow(
    "Capture operation timed out",
  );
  expect(workers.every(worker => worker.terminated)).toBe(true);
});

test("aborting a pending operation wakes scheduler and releases workers", async () => {
  const { workers, create } = factory("stall");
  const controller = new AbortController();
  const next = captureParallelFrames(plan, controller.signal, create).next();
  controller.abort("cancel render");
  await expect(next).rejects.toThrow("Video capture aborted");
  expect(workers.every(worker => worker.terminated)).toBe(true);
});

test("frame rate validation rejects overflow and over240fps but accepts exact NTSC", () => {
  expect(() => validateFramePlan({ ...plan, fps: { num: 241, den: 1 } })).toThrow();
  expect(() => validateFramePlan({ ...plan, fps: { num: 4294967296, den: 1 } })).toThrow();
  expect(() => validateFramePlan({ ...plan, fps: { num: 30, den: 4294967296 } })).toThrow();
  expect(validateFramePlan({ ...plan, fps: { num: 30000, den: 1001 } }).fps).toEqual({
    num: 30000,
    den: 1001,
  });
});
