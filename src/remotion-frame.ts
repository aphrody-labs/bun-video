import { validateNativePng, type NativeWebViewContext } from "./hyperframes-native";
import { frameOperationSignal } from "./frame-plan";

export async function prepareRemotionContext(
  context: NativeWebViewContext,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await context.navigate(url, { signal });
  const contract = await context.evaluate<boolean>(
    'typeof window.remotion_setFrame === "function" && typeof window.remotion_renderReady === "boolean"',
    { signal },
  );
  signal.throwIfAborted();
  if (!contract) throw new Error("The served page must initialize the Remotion rendering globals before hydration");
}

async function waitForRemotionReady(context: NativeWebViewContext, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const state = await context.evaluate<{ ready: boolean; cancelled: string | null }>(
      "({ready: window.remotion_renderReady === true, cancelled: window.remotion_cancelledError == null ? null : String(window.remotion_cancelledError)})",
      { signal },
    );
    signal.throwIfAborted();
    if (state.cancelled !== null) throw new Error(state.cancelled);
    if (state.ready) return;
    await Bun.sleep(10);
  }
}

export async function captureRemotionContextFrame(
  context: NativeWebViewContext,
  composition: string,
  frame: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  await waitForRemotionReady(context, signal);
  await context.evaluate(`window.remotion_setFrame(${frame}, ${JSON.stringify(composition)}, 0)`, { signal });
  await waitForRemotionReady(context, signal);
  await context.evaluate("document.fonts.ready.then(() => true)", { signal });
  signal.throwIfAborted();
  const png = await context.screenshot({ signal });
  signal.throwIfAborted();
  validateNativePng(png, frame);
  return png;
}

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
  const signal = frameOperationSignal(timeoutMs, options.signal);
  signal.throwIfAborted();
  const { BrowserRuntime } = await import("@aphrody/bun-runtime-sdk/browser");
  using runtime = BrowserRuntime.load({ libraryPath: options.libraryPath });
  using context = runtime.createContext({
    allowedOrigins: options.allowedOrigins,
    allowPrivateNetwork: options.allowPrivateNetwork,
    width: options.width,
    height: options.height,
    timeoutMs,
  });
  await prepareRemotionContext(context, options.compositionUrl, signal);
  return captureRemotionContextFrame(context, options.composition, options.frame, signal);
}
