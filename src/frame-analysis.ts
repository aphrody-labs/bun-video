import { runWebGpuJob, type WebGpuAdapterEvidence, type WebGpuOptions } from "./webgpu";

export const MAX_FRAME_ANALYSIS_PIXELS = 65536;
const RESULT_WORD = 4;
const LUMA_WORD = 20;
const RGB_WORD = LUMA_WORD + 256;
const PIXEL_WORD = RGB_WORD + 512 * 4;

export interface FrameRgba {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}
export interface FrameAnalysisOptions extends WebGpuOptions {
  /** Exclude the bottom 28% containing baked captions. Default true. */
  readonly excludeCaptionRegion?: boolean;
}
export interface FrameAnalysis {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly meanLuminance: number;
  readonly luminanceVariance: number;
  readonly laplacianVariance: number;
  readonly edgeEnergy: number;
  readonly detailScore: number;
  readonly lowDetail: boolean;
  readonly dominantColor: readonly [number, number, number] | null;
  readonly dominantBinCount: number;
  readonly luminanceHistogram: Uint32Array;
  readonly rgbHistogram: Uint32Array;
  readonly rgbQuantizationBits: 3;
  readonly captionRegionExcluded: boolean;
  readonly alphaThreshold: 128;
  readonly backend: "native" | "chromium";
  readonly adapter: WebGpuAdapterEvidence;
  readonly elapsedMs: number;
  readonly computation: "WGSL";
  readonly algorithm: "rgb8-roi-welford-laplacian-v1";
}

/** One workgroup, at most 1024 pixels per invocation; reductions stay on the GPU. */
export const FRAME_ANALYSIS_WGSL = `
struct FrameData {
  width: u32, height: u32, last_row: u32, pixel_count: u32,
  result: array<u32, 16>,
  luminance: array<atomic<u32>, 256>,
  rgb: array<atomic<u32>, 512>,
  reds: array<atomic<u32>, 512>,
  greens: array<atomic<u32>, 512>,
  blues: array<atomic<u32>, 512>,
  pixels: array<u32>,
}
@group(0) @binding(0) var<storage, read_write> data: FrameData;
var<workgroup> sums: array<vec4<f32>, 64>;
var<workgroup> edges: array<f32, 64>;
var<workgroup> counts: array<u32, 64>;
fn color(index: u32) -> vec3<u32> {
  let pixel = data.pixels[index];
  return vec3<u32>(pixel & 255u, (pixel >> 8u) & 255u, (pixel >> 16u) & 255u);
}
fn luma(index: u32) -> f32 {
  return dot(vec3<f32>(color(index)), vec3<f32>(0.2126, 0.7152, 0.0722));
}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lane: u32) {
  var totals = vec4<f32>(0.0);
  var edge = 0.0;
  var count = 0u;
  for (var index = lane; index < data.pixel_count; index += 64u) {
    let x = index % data.width;
    let y = index / data.width;
    if (x == 0u || x + 1u >= data.width || y == 0u || y + 1u >= data.last_row ||
        (data.pixels[index] >> 24u) < 128u) { continue; }
    let center = luma(index);
    let left = luma(index - 1u);
    let right = luma(index + 1u);
    let up = luma(index - data.width);
    let down = luma(index + data.width);
    let laplacian = left + right + up + down - 4.0 * center;
    edge += abs(right - left) + abs(down - up);
    count += 1u;
    let delta = center - totals.x;
    totals.x += delta / f32(count);
    totals.y += delta * (center - totals.x);
    let lap_delta = laplacian - totals.z;
    totals.z += lap_delta / f32(count);
    totals.w += lap_delta * (laplacian - totals.z);
    let rgb = color(index);
    let bin = (rgb.x >> 5u) * 64u + (rgb.y >> 5u) * 8u + (rgb.z >> 5u);
    atomicAdd(&data.luminance[min(255u, u32(center))], 1u);
    atomicAdd(&data.rgb[bin], 1u);
    atomicAdd(&data.reds[bin], rgb.x);
    atomicAdd(&data.greens[bin], rgb.y);
    atomicAdd(&data.blues[bin], rgb.z);
  }
  sums[lane] = totals;
  edges[lane] = edge;
  counts[lane] = count;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      let a = sums[lane];
      let b = sums[lane + stride];
      let count_a = f32(counts[lane]);
      let count_b = f32(counts[lane + stride]);
      let total_count = max(1.0, count_a + count_b);
      let delta = b.x - a.x;
      let lap_delta = b.z - a.z;
      sums[lane] = vec4<f32>(
        a.x + delta * count_b / total_count,
        a.y + b.y + delta * delta * count_a * count_b / total_count,
        a.z + lap_delta * count_b / total_count,
        a.w + b.w + lap_delta * lap_delta * count_a * count_b / total_count);
      edges[lane] += edges[lane + stride];
      counts[lane] += counts[lane + stride];
    }
    workgroupBarrier();
  }
  storageBarrier();
  if (lane == 0u) {
    let samples = counts[0];
    let denominator = f32(max(1u, samples));
    let mean = sums[0].x;
    let variance = max(0.0, sums[0].y / denominator);
    let lap_variance = max(0.0, sums[0].w / denominator);
    let edge_mean = edges[0] / denominator;
    let score = log(1.0 + lap_variance) + log(1.0 + edge_mean) + 0.25 * log(1.0 + variance);
    data.result[0] = samples;
    data.result[6] = bitcast<u32>(mean);
    data.result[7] = bitcast<u32>(variance);
    data.result[8] = bitcast<u32>(lap_variance);
    data.result[9] = bitcast<u32>(edge_mean);
    data.result[10] = bitcast<u32>(score);
    data.result[11] = select(0u, 1u, lap_variance < 4.0 || variance < 6.0);
    var dominant = 0u;
    var dominant_count = 0u;
    for (var bin = 0u; bin < 512u; bin += 1u) {
      let bin_count = atomicLoad(&data.rgb[bin]);
      if (bin_count > dominant_count) { dominant = bin; dominant_count = bin_count; }
    }
    data.result[1] = dominant;
    data.result[2] = dominant_count;
    let dominant_denominator = f32(max(1u, dominant_count));
    data.result[3] = bitcast<u32>(min(255.0, f32(atomicLoad(&data.reds[dominant])) / dominant_denominator));
    data.result[4] = bitcast<u32>(min(255.0, f32(atomicLoad(&data.greens[dominant])) / dominant_denominator));
    data.result[5] = bitcast<u32>(min(255.0, f32(atomicLoad(&data.blues[dominant])) / dominant_denominator));
  }
}`;

/** Validate and snapshot RGBA into the single owner's bounded storage buffer. */
export function createFrameAnalysisJob(
  frame: FrameRgba,
  options: Pick<FrameAnalysisOptions, "excludeCaptionRegion"> = {},
) {
  if (!frame || typeof frame !== "object") throw new TypeError("Frame analysis expects RGBA data and dimensions");
  const { data, width, height } = frame;
  if (!(data instanceof Uint8Array)) throw new TypeError("Frame analysis requires Uint8Array RGBA8");
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 4 ||
    height < 4 ||
    width > 256 ||
    height > 256 ||
    width * height > MAX_FRAME_ANALYSIS_PIXELS
  )
    throw new RangeError("Frame analysis dimensions must be integers 4..256, at most 65536 pixels");
  if (data.byteLength !== width * height * 4)
    throw new RangeError("Frame analysis RGBA length must equal width * height * 4");
  if (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer)
    throw new TypeError("Frame analysis does not accept concurrently mutable shared pixels");
  const excluded = options.excludeCaptionRegion ?? true;
  if (typeof excluded !== "boolean") throw new TypeError("excludeCaptionRegion must be a boolean");
  const storage = new Uint32Array(PIXEL_WORD + width * height);
  storage.set([width, height, excluded ? Math.max(3, Math.floor(height * 0.72)) : height, width * height]);
  new Uint8Array(storage.buffer, PIXEL_WORD * 4).set(data);
  return { shader: FRAME_ANALYSIS_WGSL, data: storage, workgroups: [1, 1, 1] as const, width, height, excluded };
}

/** Heuristics over native-decoded pixels; no semantic scene ranking or CPU fallback. */
export async function analyzeFrameRgba(frame: FrameRgba, options: FrameAnalysisOptions = {}): Promise<FrameAnalysis> {
  options.signal?.throwIfAborted();
  const timeout = options.timeout ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new RangeError("Frame analysis timeout must be 1..30000 milliseconds");
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const job = createFrameAnalysisJob(frame, options);
  const result = await runWebGpuJob(
    { shader: job.shader, data: job.data, workgroups: job.workgroups, signal },
    { ...options, signal },
  );
  if (result.data.byteLength !== job.data.byteLength)
    throw new Error("WebGPU returned an invalid frame-analysis buffer size");
  const view = new DataView(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  const integer = (index: number) => view.getUint32((RESULT_WORD + index) * 4, true);
  const scalar = (index: number) => {
    const value = view.getFloat32((RESULT_WORD + index) * 4, true);
    if (!Number.isFinite(value) || value < 0) throw new Error("WebGPU returned invalid frame metrics");
    return value;
  };
  const samples = integer(0);
  if (samples > job.width * job.height || integer(1) >= 512 || integer(2) > samples)
    throw new Error("WebGPU returned invalid frame sample counts");
  const histogram = (word: number, count: number) =>
    Uint32Array.from({ length: count }, (_, index) => view.getUint32((word + index) * 4, true));
  return {
    width: job.width,
    height: job.height,
    samples,
    meanLuminance: scalar(6),
    luminanceVariance: scalar(7),
    laplacianVariance: scalar(8),
    edgeEnergy: scalar(9),
    detailScore: scalar(10),
    lowDetail: integer(11) === 1,
    dominantColor: integer(2) ? [scalar(3), scalar(4), scalar(5)] : null,
    dominantBinCount: integer(2),
    luminanceHistogram: histogram(LUMA_WORD, 256),
    rgbHistogram: histogram(RGB_WORD, 512),
    rgbQuantizationBits: 3,
    captionRegionExcluded: job.excluded,
    alphaThreshold: 128,
    backend: options.backend ?? "native",
    adapter: result.adapter,
    elapsedMs: result.elapsedMs,
    computation: "WGSL",
    algorithm: "rgb8-roi-welford-laplacian-v1",
  };
}
