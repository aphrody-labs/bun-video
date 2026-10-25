import { describe, expect, test } from "bun:test";
import { analyzeFrameRgba, createFrameAnalysisJob } from "../src/frame-analysis";
import { probeChromiumWebGpu } from "../src/webgpu";

function pixels(width: number, height: number, color: (x: number, y: number) => number[]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
}

// Independent CPU reference exists only in tests; production reductions are WGSL.
function reference(frame: ReturnType<typeof pixels>, excluded = true) {
  const luma = (x: number, y: number) => {
    const offset = (y * frame.width + x) * 4;
    return frame.data[offset]! * 0.2126 + frame.data[offset + 1]! * 0.7152 + frame.data[offset + 2]! * 0.0722;
  };
  const lumas: number[] = [],
    laps: number[] = [],
    edges: number[] = [];
  const histogram = new Uint32Array(512);
  const last = excluded ? Math.max(3, Math.floor(frame.height * 0.72)) : frame.height;
  for (let y = 1; y < last - 1; y++)
    for (let x = 1; x < frame.width - 1; x++) {
      const offset = (y * frame.width + x) * 4;
      if (frame.data[offset + 3]! < 128) continue;
      lumas.push(luma(x, y));
      laps.push(luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4 * luma(x, y));
      edges.push(Math.abs(luma(x + 1, y) - luma(x - 1, y)) + Math.abs(luma(x, y + 1) - luma(x, y - 1)));
      const bin = (frame.data[offset]! >> 5) * 64 + (frame.data[offset + 1]! >> 5) * 8 + (frame.data[offset + 2]! >> 5);
      histogram[bin] = histogram[bin]! + 1;
    }
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const variance = (values: number[]) => mean(values.map(value => (value - mean(values)) ** 2));
  return {
    samples: lumas.length,
    meanLuminance: mean(lumas),
    luminanceVariance: variance(lumas),
    laplacianVariance: variance(laps),
    edgeEnergy: mean(edges),
    rgbHistogram: histogram,
  };
}

test("frame jobs validate before allocation and snapshot exactly bounded RGBA", () => {
  const frame = pixels(256, 256, () => [1, 2, 3, 255]);
  const job = createFrameAnalysisJob(frame);
  expect(job.workgroups).toEqual([1, 1, 1]);
  expect(job.data.byteLength).toBe(271440);
  frame.data.fill(0);
  expect([...new Uint8Array(job.data.buffer, job.data.byteLength - 4)]).toEqual([1, 2, 3, 255]);
  expect(() => createFrameAnalysisJob({ ...frame, width: 257 })).toThrow("4..256");
  expect(() => createFrameAnalysisJob({ ...frame, height: NaN })).toThrow("4..256");
  expect(() => createFrameAnalysisJob({ ...frame, data: frame.data.subarray(4) })).toThrow("length");
  expect(() => createFrameAnalysisJob({ ...frame, data: new Uint16Array(131072) as unknown as Uint8Array })).toThrow(
    "Uint8Array",
  );
  expect(() => createFrameAnalysisJob(frame, { excludeCaptionRegion: 1 as unknown as boolean })).toThrow("boolean");
  expect(() =>
    createFrameAnalysisJob({ ...frame, data: new Uint8Array(new SharedArrayBuffer(frame.data.byteLength)) }),
  ).toThrow("shared pixels");
});

test("analysis rejects invalid deadlines and pre-aborted jobs without loading GPU", async () => {
  const frame = pixels(8, 8, () => [0, 0, 0, 255]);
  await expect(analyzeFrameRgba(frame, { timeout: 30001 })).rejects.toThrow("1..30000");
  const controller = new AbortController();
  const reason = new Error("cancelled-before-GPU");
  controller.abort(reason);
  await expect(analyzeFrameRgba(frame, { signal: controller.signal })).rejects.toBe(reason);
});

// Host-dependent dispatch is explicit; ordinary CI exercises only hermetic bounds.
describe.skipIf(process.env.BUN_FRAME_ANALYSIS_GPU_TEST !== "1")("real Chromium WebGPU owner", () => {
  const options = {
    backend: "chromium" as const,
    timeout: 5000,
    ...(process.env.BUN_CHROMIUM_PATH ? { chromiumExecutable: process.env.BUN_CHROMIUM_PATH } : {}),
  };

  test("navigation commits the secure compute document before adapter probing", async () => {
    const probe = await probeChromiumWebGpu(options);
    expect(probe.available).toBe(true);
    expect(probe.adapter).toBe(true);
    expect(probe.fallback).toBe(false);
  });

  test.each(["flat", "checker", "gradient", "transparent"])("GPU reductions match CPU reference: %s", async kind => {
    const frame = pixels(16, 16, (x, y) => {
      if (kind === "flat") return [255, 0, 0, 255];
      if (kind === "transparent") return [255, 255, 255, 0];
      if (kind === "checker") {
        const color = ((x + y) % 2) * 255;
        return [color, color, color, 255];
      }
      return [x * 16, y * 16, (x + y) * 8, 255];
    });
    const cpu = reference(frame);
    const gpu = await analyzeFrameRgba(frame, options);
    expect(gpu.computation).toBe("WGSL");
    expect(gpu.adapter.kind).toBe("chromium");
    if (gpu.adapter.kind === "chromium") expect(gpu.adapter.fallback).toBe(false);
    expect(gpu.samples).toBe(cpu.samples);
    expect(gpu.rgbHistogram).toEqual(cpu.rgbHistogram);
    for (const key of ["meanLuminance", "luminanceVariance", "laplacianVariance", "edgeEnergy"] as const) {
      expect(Math.abs(gpu[key] - cpu[key])).toBeLessThan(Math.max(0.02, Math.abs(cpu[key]) * 0.00005));
    }
    expect(gpu.luminanceHistogram.reduce((sum, count) => sum + count, 0)).toBe(gpu.samples);
    if (kind === "flat") expect(gpu.dominantColor).toEqual([255, 0, 0]);
    if (kind === "transparent") expect(gpu.dominantColor).toBeNull();
  });

  test("caption exclusion changes the actual sampled GPU region", async () => {
    const frame = pixels(16, 16, (_, y) => (y < 11 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const cropped = await analyzeFrameRgba(frame, options);
    const complete = await analyzeFrameRgba(frame, { ...options, excludeCaptionRegion: false });
    expect(cropped.samples).toBe(126);
    expect(complete.samples).toBe(196);
    expect(cropped.dominantColor).toEqual([255, 0, 0]);
    expect(complete.rgbHistogram[7]).toBeGreaterThan(0);
    expect(complete.meanLuminance).toBeLessThan(cropped.meanLuminance);
  });

  test("the largest flat frame keeps numerically stable zero variance", async () => {
    const frame = pixels(256, 256, () => [255, 0, 0, 255]);
    const gpu = await analyzeFrameRgba(frame, options);
    expect(gpu.samples).toBe(46228);
    expect(gpu.luminanceVariance).toBe(0);
    expect(gpu.laplacianVariance).toBe(0);
    expect(gpu.detailScore).toBe(0);
    expect(gpu.dominantColor).toEqual([255, 0, 0]);
  });
});
