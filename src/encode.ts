import { isAbsolute } from "node:path";
import { captureParallelFrames } from "./parallel-capture";
import { validateFramePlan, type FramePlan } from "./frame-plan";

export interface EncodeVideoOptions {
  nativeExecutable: string;
  output: string;
  codec?: "ffv1" | "nvenc" | "qsv" | "amf";
  allowLossy?: boolean;
  ffmpegExecutable?: string;
}

/** Optional Aphrody FilmCraft export; consumes one RGBA frame at a time, never invokes FFmpeg. */
export async function encodeFilmCraftFrames(
  frames: AsyncIterable<{ data: Uint8Array; width: number; height: number }>,
  options: {
    nativeExecutable: string;
    output: string;
    width: number;
    height: number;
    fps: { num: number; den: number };
    frames: number;
    signal?: AbortSignal;
  },
) {
  const { width, height, fps } = options;
  if (![options.nativeExecutable, options.output].every(isAbsolute))
    throw new TypeError("FilmCraft requires absolute executable and output paths");
  if (
    ![width, height, fps.num, fps.den, options.frames].every(value => Number.isSafeInteger(value) && value > 0) ||
    fps.num > 0xffffffff ||
    fps.den > 0xffffffff ||
    fps.num > fps.den * 240 ||
    options.frames > 10000 ||
    width * height * 4 * options.frames > 256 * 1024 * 1024
  )
    throw new RangeError("FilmCraft export exceeds its geometry, timing or 256 MiB input budget");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(210000)])
    : AbortSignal.timeout(210000);
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      options.nativeExecutable,
      "filmcraft-encode",
      String(width),
      String(height),
      `${fps.num}/${fps.den}`,
      String(options.frames),
      options.output,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stdout = child.stdout.text(),
    stderr = child.stderr.text();
  let rejectAbort!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Observe an abort even if obtaining the caller's iterator throws synchronously.
  void interrupted.catch(() => {});
  const stop = () => {
    child.kill();
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let count = 0;
  let completed = false;
  let iterator: AsyncIterator<{ data: Uint8Array; width: number; height: number }> | undefined;
  try {
    iterator = frames[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), interrupted]);
      if (next.done) {
        completed = true;
        break;
      }
      const frame = next.value;
      signal.throwIfAborted();
      if (
        ++count > options.frames ||
        frame.width !== width ||
        frame.height !== height ||
        frame.data.byteLength !== width * height * 4
      )
        throw new Error("FilmCraft input does not match the declared frame sequence");
      if (child.exitCode !== null) throw new Error(`FilmCraft exited before consuming the frames: ${await stderr}`);
      child.stdin.write(frame.data);
      await Promise.race([child.stdin.flush(), interrupted]);
    }
    if (count !== options.frames) throw new Error("FilmCraft input ended before the declared frame count");
    await Promise.race([Promise.resolve(child.stdin.end()), interrupted]);
    const code = await Promise.race([child.exited, interrupted]);
    const [result, diagnostics] = await Promise.all([stdout, stderr]);
    signal.throwIfAborted();
    if (code !== 0 || child.signalCode) throw new Error(`FilmCraft export failed: ${diagnostics}`);
    const receipt = JSON.parse(result);
    if (
      receipt.provider !== "filmcraft" ||
      receipt.codec !== "h264" ||
      receipt.frames !== count ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 1
    )
      throw new Error("FilmCraft returned an invalid export receipt");
    return { ...receipt, output: options.output, lossless: false as const };
  } finally {
    // An arbitrary producer may also stall in return(); it cannot delay cancellation.
    if (!completed && iterator?.return)
      void Promise.resolve()
        .then(() => iterator!.return!())
        .catch(() => {});
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await Promise.allSettled([stdout, stderr]);
  }
}

export async function encodeVideo(input: FramePlan, options: EncodeVideoOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const plan = validateFramePlan(input);
  if (![options.nativeExecutable, options.output].every(isAbsolute))
    throw new TypeError("Executable and output paths must be absolute");
  if (options.ffmpegExecutable !== undefined && !isAbsolute(options.ffmpegExecutable))
    throw new TypeError("FFmpeg executable path must be absolute");
  if (options.allowLossy !== undefined && typeof options.allowLossy !== "boolean")
    throw new TypeError("allowLossy must be a boolean");
  const codec = options.codec ?? "ffv1";
  if (!["ffv1", "nvenc", "qsv", "amf"].includes(codec)) throw new TypeError("Unknown encoder");
  if (codec !== "ffv1" && !options.allowLossy) throw new Error("GPU H264 requires explicit allowLossy and drops alpha");
  const args = [
    options.nativeExecutable,
    "encode",
    codec,
    `${plan.fps.num}/${plan.fps.den}`,
    String(plan.endFrame - plan.startFrame),
    String(plan.workers),
    options.output,
  ];
  if (options.allowLossy) args.push("--allow-lossy");
  const child = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(options.ffmpegExecutable ? { BUN_VIDEO_FFMPEG: options.ffmpegExecutable } : {}),
    },
  });
  const diagnostics = new Response(child.stderr).text();
  const output = new Response(child.stdout).text();
  const abort = () => {
    if (child.exitCode === null) child.kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const frame of captureParallelFrames(plan, signal)) {
      signal?.throwIfAborted();
      if (child.exitCode !== null) throw new Error(`Encoder exited early: ${await diagnostics}`);
      child.stdin.write(frame.png);
      await child.stdin.flush();
    }
    signal?.throwIfAborted();
    await child.stdin.end();
    const code = await child.exited;
    const stderr = await diagnostics;
    await output;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`Encoder failed (${code}): ${stderr}`);
    return {
      output: options.output,
      frames: plan.endFrame - plan.startFrame,
      codec,
      lossless: codec === "ffv1",
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
