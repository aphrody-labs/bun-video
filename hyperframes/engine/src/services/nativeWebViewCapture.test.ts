import { expect, test } from "bun:test";
import { captureNativeWebViewFrames, type NativeWebViewContext } from "./nativeWebViewCapture";

test("native capture seeks exact rational frame times and emits PNG frames", async () => {
  const evaluations: string[] = [];
  const context: NativeWebViewContext = {
    async navigate(url) { expect(url).toBe("http://127.0.0.1/composition"); },
    async evaluate<T>(expression: string): Promise<T> {
      evaluations.push(expression);
      return (expression.includes("duration:") ? { ready: true, duration: 1, media: false, transitions: false } : true) as T;
    },
    async screenshot() { return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); },
  };
  const frames = [];
  for await (const frame of captureNativeWebViewFrames(context, { url: "http://127.0.0.1/composition", fps: { num: 30000, den: 1001 }, startFrame: 1, endFrame: 3 })) frames.push(frame);
  expect(frames.map((frame) => frame.timeSeconds)).toEqual([1001 / 30000, 2002 / 30000]);
  expect(evaluations[1]).toContain(`window.__hf.seek(${1001 / 30000})`);
});

test("native capture rejects unsupported media before taking a screenshot", async () => {
  let screenshots = 0;
  const context: NativeWebViewContext = {
    async navigate() {},
    async evaluate<T>(): Promise<T> { return { ready: true, duration: 1, media: true, transitions: false } as T; },
    async screenshot() { screenshots++; return new Uint8Array(); },
  };
  const generator = captureNativeWebViewFrames(context, { url: "http://127.0.0.1/", fps: { num: 30, den: 1 }, startFrame: 0, endFrame: 1 });
  await expect(generator.next()).rejects.toThrow("media injection");
  expect(screenshots).toBe(0);
});
