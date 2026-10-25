import { frameOperationSignal } from "./frame-plan";

export interface NativeWebViewContext {
  navigate(url: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  evaluate<T>(expression: string, options?: { signal?: AbortSignal }): Promise<T>;
  screenshot(options?: { signal?: AbortSignal }): Promise<Uint8Array>;
}

export interface NativeFrameCaptureOptions {
  url: string;
  fps: { num: number; den: number };
  startFrame: number;
  endFrame: number;
  frameStride?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NativeCapturedFrame {
  frame: number;
  timeSeconds: number;
  png: Uint8Array;
}

export function validateNativePng(
  png: Uint8Array,
  frame: number,
  dimensions?: { width: number; height: number },
): void {
  if (
    !(png instanceof Uint8Array) ||
    png.length < 8 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => png[index] === byte)
  )
    throw new Error(
      dimensions
        ? "Capture worker did not return a PNG IHDR"
        : `Native screenshot did not return PNG bytes for frame ${frame}`,
    );
  if (dimensions) {
    if (png.length < 33 || ![0, 0, 0, 13, 73, 72, 68, 82].every((byte, index) => png[index + 8] === byte))
      throw new Error("Capture worker did not return a PNG IHDR");
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (header.getUint32(16) !== dimensions.width || header.getUint32(20) !== dimensions.height)
      throw new Error("Capture PNG dimensions do not match the plan");
  }
}

/** The caller owns the context, viewport, origin allowlist and lifetime. */
export async function* captureNativeWebViewFrames(
  context: NativeWebViewContext,
  options: NativeFrameCaptureOptions,
): AsyncGenerator<NativeCapturedFrame> {
  const { num, den } = options.fps;
  const stride = options.frameStride ?? 1;
  if (!Number.isSafeInteger(stride) || stride < 1) {
    throw new RangeError("Native capture requires a positive integer frame stride");
  }
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new RangeError("Native capture requires a positive rational frame rate");
  }
  if (
    !Number.isSafeInteger(options.startFrame) ||
    !Number.isSafeInteger(options.endFrame) ||
    options.startFrame < 0 ||
    options.endFrame < options.startFrame
  ) {
    throw new RangeError("Native capture requires an ordered nonnegative frame range");
  }
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Native capture requires an HTTP composition URL");
  }
  options.signal?.throwIfAborted();
  const startupSignal = frameOperationSignal(options.timeoutMs, options.signal);
  await context.navigate(url.href, { signal: startupSignal });
  const contract = await context.evaluate<{
    ready: boolean;
    duration: number;
    media: boolean;
    transitions: boolean;
    webgpu: boolean;
  }>(
    "(async () => { const deadline = performance.now() + 10000; while (typeof window.__hf?.seek !== 'function') { if (performance.now() >= deadline) throw new Error('Native composition readiness timed out'); await new Promise(resolve => setTimeout(resolve, 16)); } await document.fonts?.ready; const hf = window.__hf; return { ready: true, duration: hf.duration ?? 0, media: !!document.querySelector('video,audio') || !!hf.media?.length, transitions: !!hf.transitions?.length, webgpu: !!document.querySelector('[data-requires-webgpu]') }; })()",
    { signal: startupSignal },
  );
  startupSignal.throwIfAborted();
  if (!contract.ready || !Number.isFinite(contract.duration) || contract.duration <= 0) {
    throw new Error("Composition does not expose a ready finite window.__hf seek protocol");
  }
  if (contract.media || contract.transitions || contract.webgpu) {
    throw new Error("Native capture does not support media injection, shader transitions or WebGPU requirements");
  }
  if (options.endFrame > Math.ceil((contract.duration * num) / den)) {
    throw new RangeError("Native frame range exceeds composition duration");
  }
  for (let frame = options.startFrame; frame < options.endFrame; frame += stride) {
    const signal = frameOperationSignal(options.timeoutMs, options.signal);
    const timeSeconds = (frame * den) / num;
    const acknowledged = await context.evaluate<boolean>(
      `(async () => { await window.__hf.seek(${JSON.stringify(timeSeconds)}); await window.__hfWaitForSeekCompletion?.(); await window.__hfFlushSync?.(); return true; })()`,
      { signal },
    );
    if (acknowledged !== true) throw new Error(`Native seek was not acknowledged for frame ${frame}`);
    const png = await context.screenshot({ signal });
    validateNativePng(png, frame);
    signal.throwIfAborted();
    yield { frame, timeSeconds, png };
  }
}
