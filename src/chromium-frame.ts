import type { NativeWebViewContext } from "./hyperframes-native";

/** Explicit Chromium provider for the existing frame protocol; owns only its temporary browser. */
export async function openChromiumFrameContext(options: {
  url: string;
  width: number;
  height: number;
  executable: string;
  signal: AbortSignal;
}) {
  const origin = new URL(options.url).origin;
  options.signal.throwIfAborted();
  const { default: chromium } = await import("bun:chromium");
  const browser = await chromium.launch({
    url: options.url,
    executable: options.executable,
    headless: true,
    webgpu: false,
    timeout: 30000,
    signal: options.signal,
  });
  try {
    const connection = browser.connection;
    const { targetInfos } = await connection.send<{
      targetInfos: Array<{ type: string; targetId: string; url: string }>;
    }>("Target.getTargets");
    const target = targetInfos.find(item => item.type === "page" && item.url.startsWith(`${origin}/`));
    if (!target) throw new Error("Chromium did not create the requested composition page");
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const evaluate = async <T>(expression: string, operation?: { signal?: AbortSignal }): Promise<T> => {
      options.signal.throwIfAborted();
      operation?.signal?.throwIfAborted();
      const response = await connection.send<{
        result: { value: T };
        exceptionDetails?: { text: string; exception?: { description: string } };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      options.signal.throwIfAborted();
      operation?.signal?.throwIfAborted();
      if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    };
    const context: NativeWebViewContext = {
      async navigate(url, operation) {
        if (new URL(url).origin !== origin) throw new Error("Frame navigation changed the authorized origin");
        await connection.send("Page.navigate", { url }, sessionId);
        return evaluate(
          "(async()=>{const end=performance.now()+20000;while(!window.showcaseReady){if(performance.now()>end)throw new Error('Composition startup expired');await new Promise(r=>setTimeout(r,16));}await document.fonts.ready;return true;})()",
          operation,
        );
      },
      evaluate,
      async screenshot(operation) {
        options.signal.throwIfAborted();
        operation?.signal?.throwIfAborted();
        const result = await connection.send<{ data: string }>(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: false },
          sessionId,
        );
        options.signal.throwIfAborted();
        operation?.signal?.throwIfAborted();
        return new Uint8Array(Buffer.from(result.data, "base64"));
      },
    };
    return {
      context,
      close: () => browser.close(),
      async [Symbol.asyncDispose]() {
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
