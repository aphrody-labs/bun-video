import { BrowserRuntime } from "../../../../packages/bun-runtime-sdk/src/browser";

export interface NativeFrameOptions {
  /** A served React composition initialized with Remotion's rendering globals before hydration. */
  compositionUrl: string;
  composition: string;
  frame: number;
  width: number;
  height: number;
  allowedOrigins: readonly string[];
  allowPrivateNetwork?: boolean;
  libraryPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** PNG capture of an already initialized React composition through the native Obscura provider. */
export async function captureNativeRemotionFrame(options: NativeFrameOptions): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.frame) || options.frame < 0) {
    throw new RangeError("frame must be a nonnegative safe integer");
  }
  for (const dimension of [options.width, options.height]) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new RangeError("width and height must be positive safe integers");
    }
  }
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  using runtime = BrowserRuntime.load({ libraryPath: options.libraryPath });
  using context = runtime.createContext({
    allowedOrigins: options.allowedOrigins,
    allowPrivateNetwork: options.allowPrivateNetwork,
    width: options.width,
    height: options.height,
    timeoutMs,
  });
  await context.navigate(options.compositionUrl, { signal });
  const contract = await context.evaluate<boolean>(
    'typeof window.remotion_setFrame === "function" && typeof window.remotion_renderReady === "boolean"',
    { signal },
  );
  if (!contract) {
    throw new Error(
      "The served page must initialize the Remotion React composition and rendering globals before hydration",
    );
  }
  const waitForReady = async (): Promise<void> => {
    for (;;) {
      signal.throwIfAborted();
      const state = await context.evaluate<{ ready: boolean; cancelled: string | null }>(
        "({ready: window.remotion_renderReady === true, cancelled: window.remotion_cancelledError === undefined ? null : String(window.remotion_cancelledError)})",
        { signal },
      );
      if (state.cancelled !== null) throw new Error(state.cancelled);
      if (state.ready) return;
      await Bun.sleep(10);
    }
  };
  await waitForReady();
  await context.evaluate(
    `window.remotion_setFrame(${options.frame}, ${JSON.stringify(options.composition)}, 0)`,
    { signal },
  );
  await waitForReady();
  await context.evaluate("document.fonts.ready.then(() => true)", { signal });
  return context.screenshot({ signal });
}
