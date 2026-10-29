import { Video } from "./native-video";
import "./image-compat";

interface PixelSource {
  metadata(): Promise<{ width: number; height: number }>;
  rgba(): Promise<{ width: number; height: number; channels: number; data: Uint8Array }>;
}
import { frameOperationSignal } from "./frame-plan";

export interface PixelComparison {
  width: number;
  height: number;
  differingPixels: number;
  differingPixelRatio: number;
  meanAbsoluteChannelError: number;
  maxChannelError: number;
  exact: boolean;
  passed: boolean;
}
export interface PixelLimits {
  width: number;
  height: number;
  channelTolerance?: number;
  maxDifferingPixelRatio?: number;
}

/** Compare decoded RGBA, never encoded PNG bytes or thumbnail approximations. */
export function compareRGBAFrames(reference: Uint8Array, candidate: Uint8Array, options: PixelLimits): PixelComparison {
  const { width, height } = options;
  const tolerance = options.channelTolerance ?? 0,
    ratio = options.maxDifferingPixelRatio ?? 0;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 7680 * 4320
  )
    throw new RangeError("Invalid bounded pixel dimensions");
  if (
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 255 ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1
  )
    throw new RangeError("Invalid explicit pixel comparison tolerance");
  if (reference.byteLength !== width * height * 4 || candidate.byteLength !== reference.byteLength)
    throw new RangeError("RGBA byte lengths must match the exact reference dimensions");
  let differingPixels = 0,
    sum = 0,
    maxChannelError = 0;
  for (let pixel = 0; pixel < reference.length; pixel += 4) {
    let differs = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(reference[pixel + channel]! - candidate[pixel + channel]!);
      sum += delta;
      maxChannelError = Math.max(maxChannelError, delta);
      if (delta > tolerance) differs = true;
    }
    if (differs) differingPixels++;
  }
  const differingPixelRatio = differingPixels / (width * height);
  return {
    width,
    height,
    differingPixels,
    differingPixelRatio,
    meanAbsoluteChannelError: sum / reference.length,
    maxChannelError,
    exact: maxChannelError === 0,
    passed: differingPixelRatio <= ratio,
  };
}

async function frameOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function decodeFrame(
  path: string,
  options: PixelLimits & { signal?: AbortSignal; timeoutMs?: number },
): Promise<Uint8Array> {
  const signal = frameOperationSignal(options.timeoutMs, options.signal);
  const file = Bun.file(path);
  const header = await frameOperation(() => file.slice(0, 16).bytes(), signal);
  const brand = new TextDecoder("ascii").decode(header.subarray(8, 12));
  const stillBrands = ["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"];
  const isVideo =
    file.type.startsWith("video/") ||
    (!file.type.startsWith("image/") &&
      header.length >= 12 &&
      new TextDecoder("ascii").decode(header.subarray(4, 8)) === "ftyp" &&
      !stillBrands.includes(brand));
  if (isVideo && !Video.available) throw new Error("A video provider is required to compare video frames");
  const source: PixelSource = isVideo
    ? new Video(path, { maxPixels: 7680 * 4320, autoOrient: false }).frame(0)
    : new Bun.Image(path, { maxPixels: 7680 * 4320, autoOrient: false }) as unknown as PixelSource;
  const metadata = await frameOperation<{ width: number; height: number }>(() => source.metadata(), signal);
  if (metadata.width !== options.width || metadata.height !== options.height)
    throw new Error("Frame dimensions differ from the reference; resizing is not a pixel comparison");
  if (typeof source.rgba !== "function") throw new Error("Native rgba() is required to compare frame pixels");
  const result = await frameOperation(() => source.rgba(), signal);
  if (
    result.width !== options.width ||
    result.height !== options.height ||
    result.channels !== 4 ||
    result.data.length !== options.width * options.height * 4
  )
    throw new Error("Decoded frame exceeds declared RGBA bounds");
  return result.data;
}

export async function verifyPixelFrames(
  input: PixelLimits & {
    frames: readonly { frame: number; reference: string; candidate: string }[];
    ffmpegExecutable?: string;
    ffprobeExecutable?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) {
  if (!input.frames.length || input.frames.length > 1000)
    throw new RangeError("Compare 1..1000 selected reference frames");
  // Validate bounds before any decoder allocation.
  compareRGBAFrames(new Uint8Array(4), new Uint8Array(4), {
    width: 1,
    height: 1,
    channelTolerance: input.channelTolerance,
    maxDifferingPixelRatio: input.maxDifferingPixelRatio,
  });
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width * input.height > 7680 * 4320
  )
    throw new RangeError("Invalid bounded pixel dimensions");
  const results: { frame: number; comparison: PixelComparison }[] = [];
  const seen = new Set<number>();
  for (const frame of input.frames) {
    if (!Number.isSafeInteger(frame.frame) || frame.frame < 0 || seen.has(frame.frame))
      throw new RangeError("Reference frames must be unique nonnegative integers");
    seen.add(frame.frame);
    const reference = await decodeFrame(frame.reference, input),
      candidate = await decodeFrame(frame.candidate, input);
    results.push({ frame: frame.frame, comparison: compareRGBAFrames(reference, candidate, input) });
  }
  return {
    passed: results.every(result => result.comparison.passed),
    exact: results.every(result => result.comparison.exact),
    scope: "selected-reference-frames" as const,
    frames: results,
  };
}
