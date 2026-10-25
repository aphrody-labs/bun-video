export interface FramePlan {
  kind: "remotion" | "hyperframes";
  compositionUrl: string;
  composition?: string;
  fps: { num: number; den: number };
  startFrame: number;
  endFrame: number;
  width: number;
  height: number;
  workers?: number;
  timeoutMs?: number;
  libraryPath?: string;
  allowPrivateNetwork?: boolean;
}

export function frameOperationSignal(timeoutMs = 30000, signal?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new RangeError("Capture timeout must be an integer from 1 to 300000 milliseconds");
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function validateFramePlan(plan: FramePlan): FramePlan & { workers: number; timeoutMs: number } {
  if (!plan || !["remotion", "hyperframes"].includes(plan.kind)) throw new TypeError("Unknown video composition kind");
  if (
    (plan.allowPrivateNetwork !== undefined && typeof plan.allowPrivateNetwork !== "boolean") ||
    (plan.libraryPath !== undefined && typeof plan.libraryPath !== "string")
  )
    throw new TypeError("Invalid browser provider options");
  const url = new URL(plan.compositionUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("Composition requires an HTTP(S) URL without credentials");
  const integers: Record<string, number> = {
    width: plan.width,
    height: plan.height,
    fpsNum: plan.fps?.num,
    fpsDen: plan.fps?.den,
    workers: plan.workers ?? 2,
    timeoutMs: plan.timeoutMs ?? 30000,
  };
  for (const [key, value] of Object.entries(integers))
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive safe integer`);
  if (integers.fpsNum > 0xffffffff || integers.fpsDen > 0xffffffff || integers.fpsNum > integers.fpsDen * 240)
    throw new RangeError("FPS must use u32 numerator/denominator and be at most 240");
  if (integers.workers > 16 || integers.width * integers.height > 7680 * 4320 || integers.timeoutMs > 300000)
    throw new RangeError("Plan exceeds worker, pixel or timeout limits");
  if (
    !Number.isSafeInteger(plan.startFrame) ||
    !Number.isSafeInteger(plan.endFrame) ||
    plan.startFrame < 0 ||
    plan.endFrame <= plan.startFrame ||
    plan.endFrame - plan.startFrame > 100000
  )
    throw new RangeError("Frame range must contain 1..100000 ordered frames");
  if (plan.kind === "remotion" && (typeof plan.composition !== "string" || !plan.composition))
    throw new TypeError("Remotion requires a composition id");
  return {
    ...plan,
    compositionUrl: url.href,
    workers: integers.workers,
    timeoutMs: integers.timeoutMs,
  };
}

/** Contiguous shards cover every frame once, with at most one frame difference. */
export function partitionFrames(start: number, end: number, workers: number) {
  const count = end - start;
  if (![start, end, workers].every(Number.isSafeInteger) || start < 0 || count <= 0 || workers <= 0)
    throw new RangeError("Invalid partition");
  const active = Math.min(workers, count);
  return Array.from({ length: active }, (_, index) => ({
    startFrame: start + Math.floor((count * index) / active),
    endFrame: start + Math.floor((count * (index + 1)) / active),
  }));
}
