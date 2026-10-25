export interface BrowserTask {
  url: string;
  expression?: string;
  screenshot?: boolean;
  timeoutMs?: number;
  libraryPath?: string;
}

export async function runBrowserTask(task: BrowserTask, cancellation?: AbortSignal) {
  const url = new URL(task.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("An HTTP(S) URL without credentials is required");
  const timeoutMs = task.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new RangeError("timeoutMs must be 1..300000");
  if (task.expression !== undefined && (typeof task.expression !== "string" || task.expression.length > 32768))
    throw new TypeError("expression must contain at most 32768 characters");
  const signal = cancellation
    ? AbortSignal.any([cancellation, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  const { BrowserRuntime } = await import("@aphrody/bun-runtime-sdk/browser");
  using runtime = BrowserRuntime.load({ libraryPath: task.libraryPath });
  using context = runtime.createContext({ allowedOrigins: [url.origin], timeoutMs });
  await context.navigate(url.href, { signal });
  const value = task.expression === undefined ? undefined : await context.evaluate(task.expression, { signal });
  const snapshot = await context.snapshot({ signal });
  const png = task.screenshot ? await context.screenshot({ signal }) : undefined;
  return { snapshot, value, ...(png ? { pngBase64: Buffer.from(png).toString("base64") } : {}) };
}
