import { expect, test } from "bun:test";
import { captureCompositionFrames } from "../src/render-frame";
import { validateNativePng, type NativeWebViewContext } from "../src/hyperframes-native";
import { frameOperationSignal } from "../src/frame-plan";

const plan = {
  kind: "remotion" as const,
  compositionUrl: "https://example.com/composition",
  composition: "scene",
  fps: { num: 30, den: 1 },
  startFrame: 2,
  endFrame: 7,
  width: 16,
  height: 16,
};

test("shared PNG validation preserves subarray offsets and strict capture dimensions", () => {
  const bytes = new Uint8Array(37);
  const png = bytes.subarray(4);
  png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  header.setUint32(16, 16);
  header.setUint32(20, 8);
  expect(() => validateNativePng(png, 2, { width: 16, height: 8 })).not.toThrow();
  expect(() => validateNativePng(png, 2, { width: 8, height: 16 })).toThrow("dimensions do not match");
  expect(() => validateNativePng(png.subarray(0, 8), 2)).not.toThrow();
  expect(() => validateNativePng(png.subarray(0, 8), 2, { width: 16, height: 8 })).toThrow("PNG IHDR");
});

function context(
  options: { cancelled?: string; contract?: boolean; abort?: AbortController; invalidPng?: boolean } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const capture: NativeWebViewContext = {
    async navigate(url, operation) {
      calls.push(url);
      if (operation?.signal) signals.push(operation.signal);
    },
    async evaluate<T>(expression: string, operation?: { signal?: AbortSignal }): Promise<T> {
      calls.push(expression);
      if (operation?.signal) signals.push(operation.signal);
      if (expression.startsWith("typeof")) return (options.contract ?? true) as T;
      if (expression.includes("cancelled:")) {
        options.abort?.abort(new Error("capture cancelled"));
        return { ready: !options.abort, cancelled: options.cancelled ?? null } as T;
      }
      return true as T;
    },
    async screenshot(operation) {
      calls.push("screenshot");
      if (operation?.signal) signals.push(operation.signal);
      return options.invalidPng ? new Uint8Array([1]) : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  };
  return { capture, calls, signals };
}

test("shared Remotion capture preserves frame order and forwards bounded operation signals", async () => {
  const fixture = context();
  const frames = [];
  for await (const frame of captureCompositionFrames(fixture.capture, { ...plan, frameStride: 2 }))
    frames.push(frame.frame);
  expect(frames).toEqual([2, 4, 6]);
  expect(fixture.calls.filter(call => call.startsWith("window.remotion_setFrame"))).toEqual([
    'window.remotion_setFrame(2, "scene", 0)',
    'window.remotion_setFrame(4, "scene", 0)',
    'window.remotion_setFrame(6, "scene", 0)',
  ]);
  expect(fixture.signals.length).toBe(fixture.calls.length);
});

test("shared capture rejects invalid strides and missing rendering contracts before screenshot", async () => {
  for (const stride of [0, -1, Number.NaN]) {
    const fixture = context();
    await expect(captureCompositionFrames(fixture.capture, { ...plan, frameStride: stride }).next()).rejects.toThrow(
      "stride",
    );
    expect(fixture.calls).toEqual([]);
  }
  const fixture = context({ contract: false });
  await expect(captureCompositionFrames(fixture.capture, plan).next()).rejects.toThrow("rendering globals");
  expect(fixture.calls).not.toContain("screenshot");
});

test("shared capture propagates renderer failure and cancellation without emitting a frame", async () => {
  const failed = context({ cancelled: "render failed" });
  await expect(captureCompositionFrames(failed.capture, plan).next()).rejects.toThrow("render failed");
  expect(failed.calls).not.toContain("screenshot");
  const abort = new AbortController();
  const cancelled = context({ abort });
  await expect(captureCompositionFrames(cancelled.capture, { ...plan, signal: abort.signal }).next()).rejects.toThrow(
    "capture cancelled",
  );
  expect(cancelled.calls).not.toContain("screenshot");
});

test("shared Remotion capture rejects non-PNG output before emitting it", async () => {
  const fixture = context({ invalidPng: true });
  await expect(captureCompositionFrames(fixture.capture, plan).next()).rejects.toThrow("PNG bytes for frame 2");
});

test("HyperFrames shares bounded native seek and screenshot operations", async () => {
  const signals: AbortSignal[] = [];
  const abort = new AbortController();
  const capture: NativeWebViewContext = {
    async navigate(_url, options) {
      signals.push(options!.signal!);
    },
    async evaluate<T>(expression: string, options?: { signal?: AbortSignal }): Promise<T> {
      signals.push(options!.signal!);
      return (
        expression.includes("const hf =")
          ? { ready: true, duration: 1, media: false, transitions: false, webgpu: false }
          : true
      ) as T;
    },
    async screenshot(options) {
      signals.push(options!.signal!);
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    },
  };
  const frames = captureCompositionFrames(capture, { ...plan, kind: "hyperframes", signal: abort.signal });
  const first = await frames.next();
  expect(first.value?.frame).toBe(2);
  expect(signals).toHaveLength(4);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[2]).toBe(signals[3]);
  expect(signals[0]).not.toBe(signals[2]);
  abort.abort(new Error("HyperFrames cancelled"));
  await expect(frames.next()).rejects.toThrow("HyperFrames cancelled");
  expect(signals).toHaveLength(4);
});

test("the shared operation boundary validates deadlines and preexisting cancellation", () => {
  for (const timeout of [0, -1, Number.NaN, 300001])
    expect(() => frameOperationSignal(timeout)).toThrow("Capture timeout");
  const abort = new AbortController();
  abort.abort(new Error("already cancelled"));
  expect(() => frameOperationSignal(1000, abort.signal)).toThrow("already cancelled");
});
