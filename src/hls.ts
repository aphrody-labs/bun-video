// SPDX-License-Identifier: Apache-2.0
export * from "@aphrody/bun-runtime-sdk/video/hls";
import { attachHlsPlayback, type HlsPlaybackOptions } from "@aphrody/bun-runtime-sdk/video/hls";
import type Hls from "hls.js";
import type { HlsConfig } from "hls.js";

export function getHlsBrowserAssetPath(): string {
  return Bun.resolveSync("hls.js", import.meta.dir).replace(/[\\/][^\\/]+$/, "/hls.min.js");
}

export async function getHlsPublicAssets() {
  const browser = getHlsBrowserAssetPath();
  const directory = browser.replace(/[\\/][^\\/]+$/, "");
  const root = directory.replace(/[\\/][^\\/]+$/, "");
  const metadata = await Bun.file(`${root}/package.json`).json();
  // Bundled entrypoints share dist/chunks, while source entrypoints live in src.
  let location = new URL("./", import.meta.url);
  let owner: { name?: string; dependencies?: Record<string, string> } | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const manifest = Bun.file(new URL("package.json", location));
    if (await manifest.exists()) {
      const candidate = await manifest.json();
      if (candidate.name === "@aphrody/bun-video") {
        owner = candidate;
        break;
      }
    }
    const parent = new URL("../", location);
    if (parent.href === location.href) break;
    location = parent;
  }
  if (!owner) throw new Error("Bun Video's package manifest was not found");
  if (metadata.name !== "hls.js" || metadata.version !== owner.dependencies?.["hls.js"])
    throw new Error("Bun Video's HLS decoder differs from its pinned dependency");
  return { version: metadata.version as string, worker: `${directory}/hls.worker.js`, license: `${root}/LICENSE` };
}

export async function attachVideoHlsPlayback(
  video: HTMLVideoElement,
  options: HlsPlaybackOptions<Partial<HlsConfig>, Hls> & { decoder?: typeof Hls },
) {
  const view = video.ownerDocument?.defaultView;
  if (!view || !(video instanceof view.HTMLVideoElement))
    throw new Error("HLS playback requires a browser video element.");
  const { decoder, ...playbackOptions } = options;
  const Decoder = decoder ?? (await import("hls.js")).default;
  return attachHlsPlayback(video, Decoder, {
    ...playbackOptions,
    config: { enableWorker: false, ...options.config },
  });
}
