import { remotion, hyperframes } from "./upstream-provenance";

export async function capabilities() {
  const { BrowserRuntime } = await import("@aphrody/bun-runtime-sdk/browser");
  let nativeBrowser: { providerLoaded: boolean; renderingQualified: false; error?: string };
  try {
    using runtime = BrowserRuntime.load();
    nativeBrowser = { providerLoaded: !runtime.closed, renderingQualified: false };
  } catch (error) {
    nativeBrowser = { providerLoaded: false, renderingQualified: false, error: String(error) };
  }
  let chromiumWebGpu: { apiAvailable: boolean; error?: string };
  try {
    await import("bun:chromium");
    chromiumWebGpu = { apiAvailable: true };
  } catch (error) {
    chromiumWebGpu = { apiAvailable: false, error: String(error) };
  }
  let nativeWebGpu: { providerLoaded: boolean; wgsl: boolean; error?: string };
  try {
    const { GPU_CAPABILITIES, GpuRuntime } = await import("@aphrody/bun-runtime-sdk/gpu");
    using runtime = GpuRuntime.load();
    nativeWebGpu = { providerLoaded: !runtime.closed, wgsl: GPU_CAPABILITIES.includes("gpu.wgsl") };
  } catch (error) {
    nativeWebGpu = { providerLoaded: false, wgsl: false, error: String(error) };
  }
  return {
    name: "bun-video",
    runtime: {
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      arch: process.arch,
    },
    upstream: { remotion, hyperframes },
    nativeBrowser,
    webgpu: { chromium: chromiumWebGpu, native: nativeWebGpu },
    backends: {
      remotion: "Official upstream library; renderer dependencies must be available",
      hyperframes: "Official upstream library; renderer dependencies must be available",
      native: "Explicit served-composition PNG capture; requires a qualified browser-enabled provider",
    },
  };
}

/** One public-safe capability contract shared by the web API, CLI and MCP. */
export async function productCapabilities(options: { youtubeSearchEnabled?: boolean } = {}) {
  const [runtime, { describeVideoAPIs }] = await Promise.all([capabilities(), import("./video-api")]);
  const { name, runtime: runtimeInfo, upstream, nativeBrowser, webgpu, backends } = runtime;
  return {
    schema: "bun-video/product-capabilities/v1",
    runtime: {
      name,
      ...runtimeInfo,
      upstream,
      nativeBrowser: {
        providerLoaded: nativeBrowser.providerLoaded,
        renderingQualified: nativeBrowser.renderingQualified,
      },
      webgpu: {
        chromium: { apiAvailable: webgpu.chromium.apiAvailable },
        native: { providerLoaded: webgpu.native.providerLoaded, wgsl: webgpu.native.wgsl },
      },
      backends,
    },
    apiFamilies: describeVideoAPIs(),
    surfaces: { http: true, cli: true, mcp: true },
    integrations: {
      filmcraft: {
        providerAvailable: Bun.Video.available,
        decoder: Bun.Video.decoder,
        backend: Bun.Video.backend,
      },
      remotion: {
        version: runtime.upstream.remotion.version,
        apiFamily: "remotion",
        rendererFamily: "remotion-renderer",
      },
      hyperframes: {
        version: runtime.upstream.hyperframes.version,
        apiFamily: "hyperframes",
        rendererFamily: "hyperframes-engine",
      },
      youtube: {
        searchEnabled: options.youtubeSearchEnabled ?? !!Bun.env.BUN_VIDEO_YOUTUBE_API_KEY,
        playback: "official-iframe",
        mediaExtraction: "unsupported",
      },
      ytDlp: { apiFamily: "ytdlp", mediaWorkflow: "authorized-non-YouTube-sources" },
    },
  } as const;
}
