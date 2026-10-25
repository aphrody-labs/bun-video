import { GpuRuntime, type GpuAdapter, type GpuReport, type WgslJob } from "@aphrody/bun-runtime-sdk/gpu";

const MAX_DATA_BYTES = 16 * 1024 * 1024;
const PROBE_HTML = "<!doctype html><meta charset=utf-8><title>bun-video WebGPU</title>";

export interface BrowserWebGpuInfo {
  available: boolean;
  adapter: boolean;
  fallback: boolean | null;
  info: { vendor: string; architecture: string; device: string; description: string } | null;
}

export interface WebGpuJob extends Omit<WgslJob, "signal"> {
  readonly signal?: AbortSignal;
}

export interface WebGpuOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly backend?: "native" | "chromium";
  readonly libraryPath?: string;
  readonly chromiumExecutable?: string;
  /** Origin of an already mounted probe page; when set, no probe listener is started. */
  readonly origin?: string;
}

export const WEBGPU_PROBE_HTML = PROBE_HTML;

export type WebGpuAdapterEvidence =
  | { kind: "native"; selected: GpuReport["selected"]; limits: GpuReport["limits"] }
  | { kind: "chromium"; info: BrowserWebGpuInfo["info"]; fallback: boolean | null };

interface ChromiumConnection {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  gpu(sessionId: string): Promise<BrowserWebGpuInfo>;
  close(): void;
  on(method: string, callback: (params: Record<string, unknown>, sessionId?: string) => void): () => void;
}

interface ChromiumModule {
  launch(options: {
    url: string;
    executable?: string;
    headless: boolean;
    webgpu: boolean;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<{ connection: ChromiumConnection; process: { exited: Promise<number> }; close(): Promise<void> }>;
}

async function navigateComputePage(
  browser: Awaited<ReturnType<ChromiumModule["launch"]>>,
  sessionId: string,
  url: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const connection = browser.connection;
  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
  const completed = new Set<string>();
  let loader: string | undefined;
  const ready = Promise.withResolvers<void>();
  const remove = connection.on("Page.lifecycleEvent", (params, eventSession) => {
    if (eventSession !== sessionId || params.name !== "load" || typeof params.loaderId !== "string") return;
    completed.add(params.loaderId);
    if (params.loaderId === loader) ready.resolve();
  });
  const abort = () => ready.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  void browser.process.exited.then(
    code => ready.reject(new Error(`Chromium exited during navigation (${code})`)),
    ready.reject,
  );
  try {
    await Promise.all([
      connection
        .send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url }, sessionId)
        .then(navigation => {
          if (navigation.errorText) throw new Error(`Chromium compute navigation failed: ${navigation.errorText}`);
          if (!navigation.loaderId) throw new Error("Chromium compute navigation did not create a document loader");
          loader = navigation.loaderId;
          if (completed.has(loader)) ready.resolve();
        }),
      ready.promise,
    ]);
    signal.throwIfAborted();
  } finally {
    remove();
    signal.removeEventListener("abort", abort);
  }
}

async function withChromiumPage<T>(
  operation: (connection: ChromiumConnection, sessionId: string) => Promise<T>,
  options: WebGpuOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeout ?? 15_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const server = options.origin
    ? undefined
    : Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(PROBE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
      });
  const base = options.origin ?? `http://127.0.0.1:${server!.port}`;
  let browser: Awaited<ReturnType<ChromiumModule["launch"]>> | undefined;
  try {
    const { default: chromium } = (await import("bun:chromium")) as unknown as {
      default: ChromiumModule;
    };
    browser = await chromium.launch({
      url: `${base}/webgpu`,
      ...(options.chromiumExecutable === undefined ? {} : { executable: options.chromiumExecutable }),
      headless: true,
      webgpu: true,
      timeout: options.timeout ?? 15_000,
      signal,
    });
    const targets = await browser.connection.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    }>("Target.getTargets");
    const target = targets.targetInfos.find(item => item.type === "page" && item.url === `${base}/webgpu`);
    if (!target) throw new Error("Chromium did not create the WebGPU probe page");
    const attached = await browser.connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    await navigateComputePage(browser, attached.sessionId, `${base}/webgpu`, signal);
    return await operation(browser.connection, attached.sessionId);
  } finally {
    await browser?.close();
    server?.stop(true);
  }
}

/** Probe the actual WebGPU adapter selected by a Bun-launched Chromium process. */
export async function probeChromiumWebGpu(options: WebGpuOptions = {}): Promise<BrowserWebGpuInfo> {
  return await withChromiumPage(async (connection, sessionId) => await connection.gpu(sessionId), options);
}

function validateJob(job: WebGpuJob): void {
  if (!job || typeof job.shader !== "string" || job.shader.length === 0 || job.shader.length > 1_048_576)
    throw new TypeError("WGSL shader must contain 1 byte..1 MiB");
  if (job.entryPoint !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(job.entryPoint))
    throw new TypeError("WGSL entryPoint must be a valid identifier");
  if (
    !Array.isArray(job.workgroups) ||
    job.workgroups.length !== 3 ||
    job.workgroups.some(count => !Number.isSafeInteger(count) || count < 1 || count > 65535)
  )
    throw new RangeError("workgroups must contain three integers from 1 to 65535");
  if (!ArrayBuffer.isView(job.data)) throw new TypeError("WGSL data must be an ArrayBuffer view");
  if (job.data.byteLength < 4 || job.data.byteLength > MAX_DATA_BYTES || job.data.byteLength % 4 !== 0)
    throw new RangeError("WGSL data must be a nonempty 4-byte multiple up to 16 MiB");
}

function browserComputeExpression(job: WebGpuJob): string {
  const bytes = new Uint8Array(job.data.buffer, job.data.byteOffset, job.data.byteLength);
  const encoded = Buffer.from(bytes).toString("base64");
  return `(async () => {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in this Chromium build");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("Chromium found no WebGPU adapter");
    const device = await adapter.requestDevice();
    const encoded = ${JSON.stringify(encoded)};
    const data = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const shader = ${JSON.stringify(job.shader)};
    const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readback = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    const module = device.createShaderModule({ code: shader });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length) throw new Error(errors.map((message) => message.message).join("\\n"));
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: ${JSON.stringify(job.entryPoint ?? "main")} } });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
    const command = device.createCommandEncoder();
    const pass = command.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(${job.workgroups.join(",")}); pass.end();
    command.copyBufferToBuffer(buffer, 0, readback, 0, data.byteLength);
    const started = performance.now(); device.queue.submit([command.finish()]); await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(readback.getMappedRange().slice(0));
    const elapsedMs = performance.now() - started;
    readback.unmap(); readback.destroy(); buffer.destroy(); device.destroy();
    let binary = ""; for (const byte of result) binary += String.fromCharCode(byte);
    const info = adapter.info;
    return { data: btoa(binary), elapsedMs, adapter: {
      kind: "chromium",
      fallback: typeof info?.isFallbackAdapter === "boolean" ? info.isFallbackAdapter : null,
      info: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null
    } };
  })()`;
}

async function runChromiumWgsl(job: WebGpuJob, options: WebGpuOptions) {
  return await withChromiumPage(async (connection, sessionId) => {
    const response = await connection.send<{
      result: { value?: { data: string; elapsedMs: number; adapter: WebGpuAdapterEvidence } };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression: browserComputeExpression(job),
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "WebGPU compute failed",
      );
    const value = response.result.value;
    if (!value || typeof value.data !== "string" || !Number.isFinite(value.elapsedMs))
      throw new Error("Chromium returned an invalid WebGPU result");
    return {
      data: new Uint8Array(Buffer.from(value.data, "base64")),
      elapsedMs: value.elapsedMs,
      adapter: value.adapter,
    };
  }, options);
}

/** Execute bounded WGSL using Chromium WebGPU or the native wgpu-backed runtime provider. */
export async function runWebGpuJob(job: WebGpuJob, options: WebGpuOptions = {}) {
  validateJob(job);
  const backend = options.backend ?? "native";
  if (backend === "chromium") return await runChromiumWgsl(job, options);
  if (backend !== "native") throw new TypeError("backend must be native or chromium");
  using runtime =
    options.libraryPath === undefined ? GpuRuntime.load() : GpuRuntime.load({ libraryPath: options.libraryPath });
  const signal = options.signal ?? job.signal;
  const nativeJob: WgslJob = {
    shader: job.shader,
    workgroups: job.workgroups,
    data: job.data,
    ...(job.entryPoint === undefined ? {} : { entryPoint: job.entryPoint }),
    ...(signal === undefined ? {} : { signal }),
  };
  const info = await runtime.info(signal === undefined ? undefined : { signal });
  const result = await runtime.wgsl(nativeJob);
  return {
    ...result,
    adapter: { kind: "native", selected: info.selected, limits: info.limits } as WebGpuAdapterEvidence,
  };
}

/** Read adapter and limits from the native wgpu/CUDA provider used by Linux serverless jobs. */
export async function nativeWebGpuInfo(options: Pick<WebGpuOptions, "libraryPath"> = {}): Promise<GpuReport> {
  using runtime = GpuRuntime.load(options.libraryPath === undefined ? {} : { libraryPath: options.libraryPath });
  return await runtime.info();
}

export type { GpuAdapter, GpuReport };

export interface DesktopWebGpuSession {
  readonly url: string;
  readonly result: Promise<BrowserWebGpuInfo>;
  readonly closed: Promise<number>;
  close(): Promise<void>;
}

/** Open the native CEF desktop host and report the WebGPU adapter from its visible window. */
export async function openWindowsWebGpuDesktop(options: { signal?: AbortSignal } = {}): Promise<DesktopWebGpuSession> {
  if (process.platform !== "win32") throw new Error("The native Bun Video desktop app currently targets Windows");
  options.signal?.throwIfAborted();
  const { desktop } = await import("@aphrody/bun-runtime-sdk/desktop");
  let resolveResult!: (value: BrowserWebGpuInfo) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<BrowserWebGpuInfo>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bun Video WebGPU</title><style>body{background:#141519;color:#fff;font:16px system-ui;max-width:48rem;margin:10vh auto;padding:2rem}code{color:#f47521}</style><h1>Bun Video WebGPU</h1><p id="status">Vérification de l’adaptateur depuis le moteur desktop natif…</p><pre id="details"></pre><script>async function run(){let report;try{const adapter=await navigator.gpu?.requestAdapter();if(!navigator.gpu)throw Error("WebGPU unavailable");if(!adapter)throw Error("No WebGPU adapter");const i=adapter.info;report={available:true,adapter:true,fallback:typeof i?.isFallbackAdapter==="boolean"?i.isFallbackAdapter:null,info:i?{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description}:null}}catch(e){report={available:false,adapter:false,fallback:null,info:null,error:String(e)}}document.querySelector("#status").textContent=report.available?"WebGPU adapter ready":"WebGPU unavailable";document.querySelector("#details").textContent=JSON.stringify(report,null,2);await fetch("/result",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(report)})}run()</script>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/result" && request.method === "POST") {
        void request
          .json()
          .then((value: unknown) => {
            if (settled) return;
            settled = true;
            resolveResult(value as BrowserWebGpuInfo);
          })
          .catch((error: unknown) => {
            if (settled) return;
            settled = true;
            rejectResult(error instanceof Error ? error : new Error(String(error)));
          });
        return new Response(null, { status: 204 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  let session: Awaited<ReturnType<typeof desktop.open>> | undefined;
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    session = await desktop.open({
      grants: ["window.create"],
      allowedOrigins: [new URL(url).origin],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await session.createWindow({ url, title: "Bun Video WebGPU", width: 1000, height: 700 });
  } catch (error) {
    await session?.close();
    server.stop(true);
    throw error;
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${server.port}/`,
    result,
    closed: session.process.waitForExit(),
    async close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      await session?.close();
    },
  };
}
