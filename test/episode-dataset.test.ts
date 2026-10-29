import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  assessAsrRepetition,
  cueFrameCandidates,
  episodeTemporalSplit,
  measureFrameDetail,
  overlapCues,
  pcm16MonoWave,
  thumbnailPixels,
} from "../src/episode-dataset";

test("bilingual cue alignment measures actual overlap without inventing semantic equivalence", () => {
  const matches = overlapCues({ startMs: 1000, endMs: 3000, text: "fr" }, [
    { startMs: 2000, endMs: 4000, text: "ja" },
    { startMs: 3000, endMs: 5000, text: "none" },
  ]);
  expect(matches).toEqual([
    {
      cueNumber: 1,
      startMs: 2000,
      endMs: 4000,
      text: "ja",
      overlapMs: 1000,
      frenchCoverage: 0.5,
      japaneseCoverage: 0.5,
    },
  ]);
});

test("adjacent cues in one 30-second block keep the same deterministic partition", () => {
  expect(episodeTemporalSplit("one", 1000)).toBe(episodeTemporalSplit("one", 29000));
  expect(episodeTemporalSplit("one", 1000)).toBe(episodeTemporalSplit("one", 1000));
  expect(() => episodeTemporalSplit("one", -1)).toThrow("split");
});

test("cue frame selection keeps rational frame rate and sequence boundaries", () => {
  expect(
    cueFrameCandidates({ startMs: 0, endMs: 1000, text: "cue" }, { numerator: 24000, denominator: 1001 }, 100),
  ).toEqual([6, 12, 18]);
  expect(
    cueFrameCandidates({ startMs: 5000, endMs: 6000, text: "cue" }, { numerator: 24, denominator: 1 }, 10),
  ).toEqual([10]);
});

test.skipIf(Bun.env.BUN_VIDEO_TEST_GPU !== "1")(
  "shared GPU detail metric distinguishes structure and excludes subtitle region",
  async () => {
    const options = {
      backend: "chromium" as const,
      chromiumExecutable: Bun.env.BUN_VIDEO_CHROMIUM_EXECUTABLE,
      timeout: 5000,
    };
    const flat = new Uint8Array(16 * 16 * 4).fill(128);
    const grid = new Uint8Array(flat);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) for (let c = 0; c < 3; c++) grid[(y * 16 + x) * 4 + c] = (x + y) % 2 ? 255 : 0;
    const flatMetrics = await measureFrameDetail(flat, 16, 16, options);
    const gridMetrics = await measureFrameDetail(grid, 16, 16, options);
    expect(gridMetrics.laplacianVariance).toBeGreaterThan(flatMetrics.laplacianVariance);
    expect(gridMetrics.computation).toBe("WGSL");
    expect(gridMetrics.backend).toBe("chromium");
    expect(gridMetrics.samples).toBeGreaterThan(0);
    const bottom = new Uint8Array(flat);
    for (let y = 12; y < 16; y++) for (let x = 0; x < 16; x++) bottom[(y * 16 + x) * 4] = 255;
    const bottomMetrics = await measureFrameDetail(bottom, 16, 16, options);
    expect(bottomMetrics.laplacianVariance).toBeCloseTo(flatMetrics.laplacianVariance, 4);
    expect(bottomMetrics.meanLuminance).toBeCloseTo(flatMetrics.meanLuminance, 4);
  },
);

test("thumbnail owner rejects unbounded payloads before decoding", async () => {
  await expect(thumbnailPixels(new Uint8Array(10))).rejects.toThrow("bounded");
  await expect(thumbnailPixels(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow("bounded");
  await expect(measureFrameDetail(new Uint8Array(4), 1, 1, { backend: "chromium" })).rejects.toThrow("bounded");
  await expect(measureFrameDetail(new Uint8Array(64), 4, 4, {})).rejects.toThrow("explicit GPU backend");
});

test("ASR quality check rejects repeated hallucination patterns but allows short utterances", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    text: "同じ長い文章の繰り返し",
  }));
  expect(assessAsrRepetition(rows).rejected).toBe(true);
  expect(assessAsrRepetition(rows.map(row => ({ ...row, text: "ああ" }))).rejected).toBe(false);
  expect(assessAsrRepetition(rows.map((row, i) => ({ ...row, text: `文章に異なる情報${i}` }))).rejected).toBe(false);
});

test("PCM audio windows preserve exact samples and standard mono 16kHz WAV fields", () => {
  const samples = new Uint8Array([1, 0, 255, 255, 0, 0, 127, 0]);
  const bytes = pcm16MonoWave(samples),
    view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(samples.length);
  expect(bytes.subarray(44)).toEqual(samples);
  expect(() => pcm16MonoWave(new Uint8Array(3))).toThrow("bounded");
  expect(() => pcm16MonoWave(new Uint8Array(2), 48000)).toThrow("bounded");
});

test.skipIf(typeof Bun.Image.prototype.rgba !== "function")(
  "native thumbnail PNG owner preserves exact RGBA and rejects malformed compressed input",
  async () => {
    const joinBytes = (parts: Uint8Array[]) => {
      const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    };
    const chunk = (type: string, bytes: Uint8Array) => {
      const output = new Uint8Array(bytes.length + 12);
      const view = new DataView(output.buffer);
      view.setUint32(0, bytes.length);
      output.set(new TextEncoder().encode(type), 4);
      output.set(bytes, 8);
      view.setUint32(bytes.length + 8, Bun.hash.crc32(output.subarray(4, bytes.length + 8)));
      return output;
    };
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 2);
    view.setUint32(4, 2);
    header[8] = 8;
    header[9] = 6;
    const rows = new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 255, 1, 0, 0, 255, 255, 255, 255, 0, 0]);
    const png = joinBytes([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(await thumbnailPixels(png)).toEqual({
      width: 2,
      height: 2,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    });
    const corrupt = new Uint8Array(png);
    // Invalidate the real zlib header (Bun.deflateSync emits raw deflate, so node:zlib builds the IDAT).
    corrupt[41] = 0;
    await expect(thumbnailPixels(corrupt)).rejects.toThrow();
    const invalidRows = new Uint8Array(1024 * 1024);
    invalidRows[0] = 255;
    const bomb = joinBytes([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(invalidRows)),
      chunk("IEND", new Uint8Array()),
    ]);
    await expect(thumbnailPixels(bomb)).rejects.toThrow();
  },
);
