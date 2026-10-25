import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRGBAFrames, verifyPixelFrames } from "../src/pixel-verify";

const work = mkdtempSync(join(tmpdir(), "bun-video-pixel-verify-"));
const png = join(work, "reference.png");
beforeAll(async () => {
  await Bun.write(
    png,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42IAAAAASUVORK5CYII=",
      "base64",
    ),
  );
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
test("pixel comparison detects channel and alpha differences with exact default", () => {
  const reference = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
  expect(compareRGBAFrames(reference, reference, { width: 2, height: 1 })).toMatchObject({
    passed: true,
    exact: true,
    differingPixels: 0,
    maxChannelError: 0,
  });
  const candidate = reference.slice();
  candidate[7] = 127;
  expect(compareRGBAFrames(reference, candidate, { width: 2, height: 1 })).toMatchObject({
    passed: false,
    exact: false,
    differingPixels: 1,
    differingPixelRatio: 0.5,
    maxChannelError: 1,
  });
  expect(compareRGBAFrames(reference, candidate, { width: 2, height: 1, channelTolerance: 1 })).toMatchObject({
    passed: true,
    exact: false,
  });
});
test("comparison rejects ambiguous sizes and invalid tolerances", () => {
  expect(() => compareRGBAFrames(new Uint8Array(4), new Uint8Array(3), { width: 1, height: 1 })).toThrow("lengths");
  expect(() =>
    compareRGBAFrames(new Uint8Array(4), new Uint8Array(4), { width: 1, height: 1, maxDifferingPixelRatio: NaN }),
  ).toThrow("tolerance");
});

test("native comparison rejects mismatched dimensions without resampling", async () => {
  await expect(
    verifyPixelFrames({
      width: 2,
      height: 1,
      frames: [{ frame: 0, reference: png, candidate: png }],
      ffmpegExecutable: "unused",
      ffprobeExecutable: "unused",
    }),
  ).rejects.toThrow("resizing is not a pixel comparison");
});

test.skipIf(typeof Bun.Image.prototype.rgba !== "function")(
  "native image pixels are compared without media executables",
  async () => {
    const result = await verifyPixelFrames({
      width: 1,
      height: 1,
      frames: [{ frame: 0, reference: png, candidate: png }],
      ffmpegExecutable: "unused",
      ffprobeExecutable: "unused",
    });
    expect(result).toMatchObject({ passed: true, exact: true, scope: "selected-reference-frames" });
    expect(result.frames[0]?.comparison).toMatchObject({ differingPixels: 0, maxChannelError: 0 });
  },
);

test("native comparison honors cancellation before opening a frame", async () => {
  await expect(
    verifyPixelFrames({
      width: 1,
      height: 1,
      frames: [{ frame: 0, reference: "missing", candidate: "missing" }],
      signal: AbortSignal.abort(new Error("comparison cancelled")),
    }),
  ).rejects.toThrow("comparison cancelled");
});
