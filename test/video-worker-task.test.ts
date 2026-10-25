import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeVideoTask,
  validateVideoTask,
  videoTaskFrameRate,
  validatePNGSequence,
  type VideoRenderTask,
} from "../src/video-worker-task";

const task = (root: string): VideoRenderTask => ({
  source: { kind: "file", value: join(root, "source.mp4") },
  engine: "hyperframes",
  output: join(root, "output.mp4"),
  width: 320,
  height: 180,
  fps: 30,
  durationFrames: 3,
  workDirectory: join(root, "job"),
});

describe("video task contract", () => {
  test("orders renderer PNG frames and rejects missing or duplicate frames", () => {
    expect(validatePNGSequence(["frame_000002.png", "frame_000000.png", "frame_000001.png"], 3)).toEqual({
      pattern: "frame_%06d.png",
      startNumber: 0,
    });
    expect(validatePNGSequence(["element-01.png", "element-02.png"], 2)).toEqual({
      pattern: "element-%02d.png",
      startNumber: 1,
    });
    expect(() => validatePNGSequence(["frame_000001.png", "frame_000003.png"], 2)).toThrow("consecutive");
    expect(() => validatePNGSequence(["frame_000001.png", "frame_000001.png"], 2)).toThrow("consecutive");
    expect(() => validatePNGSequence(["../frame_000001.png"], 1)).toThrow("safe numeric");
    expect(() => validatePNGSequence([], 1)).toThrow("frame count");
  });
  test("rejects malformed work before acquisition", () => {
    const root = mkdtempSync(join(tmpdir(), "video-task-"));
    try {
      expect(() => validateVideoTask({ ...task(root), durationFrames: 0 })).toThrow("durationFrames");
      expect(() => validateVideoTask({ ...task(root), frameWorkers: 5 })).toThrow("frameWorkers");
      expect(() => validateVideoTask({ ...task(root), videoFrameFormat: "gif" as "png" })).toThrow("videoFrameFormat");
      expect(videoTaskFrameRate({ num: 30000, den: 1001 })).toEqual({ value: 30000 / 1001, argument: "30000/1001" });
      expect(() => validateVideoTask({ ...task(root), fps: { num: 30000, den: 0 } })).toThrow("fps");
      expect(() => validateVideoTask({ ...task(root), width: 10000, height: 10000 })).toThrow("pixel budget");
      expect(() => validateVideoTask({ ...task(root), timeoutMs: 3600001 })).toThrow("timeoutMs");
      expect(() =>
        validateVideoTask({ ...task(root), source: { kind: "direct", value: "file:///private/video.mp4" } }),
      ).toThrow("HTTP");
      expect(() => validateVideoTask({ ...task(root), id: "../escape" })).toThrow("task id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects ambiguous captured video requests rather than choosing one", async () => {
    const root = mkdtempSync(join(tmpdir(), "video-task-"));
    try {
      const capture = join(root, "network.json");
      await Bun.write(
        capture,
        JSON.stringify({
          requests: [
            { requestId: "one", request: { url: "http://127.0.0.1/video.mp4" }, response: { mimeType: "video/mp4" } },
            { requestId: "two", request: { url: "http://127.0.0.1/other.mp4" }, response: { mimeType: "video/mp4" } },
          ],
        }),
      );
      await expect(
        executeVideoTask({
          ...task(root),
          engineExecutable: process.execPath,
          source: { kind: "capture", value: capture },
        }),
      ).rejects.toThrow("exactly one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("honors an already cancelled job", async () => {
    const root = mkdtempSync(join(tmpdir(), "video-task-"));
    try {
      await expect(executeVideoTask(task(root), { signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow(
        "cancelled",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("preserves an existing output before any source or engine work", async () => {
    const root = mkdtempSync(join(tmpdir(), "video-task-"));
    try {
      const input = task(root);
      await Bun.write(input.output, "owned video output");
      await expect(executeVideoTask(input)).rejects.toThrow("already exists");
      expect(await Bun.file(input.output).text()).toBe("owned video output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
