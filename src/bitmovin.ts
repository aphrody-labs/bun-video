// SPDX-License-Identifier: Apache-2.0
import type { LocationConfig, PlayerAPI, PlayerConfig } from "bitmovin-player";

export type { PlayerAPI, PlayerConfig, SourceConfig } from "bitmovin-player";

export async function loadBitmovinPlayer(): Promise<typeof import("bitmovin-player")> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Bitmovin Player requires a browser DOM; import is deferred until browser use.");
  }
  return import("bitmovin-player");
}

export async function createBitmovinPlayer(container: HTMLElement, config: PlayerConfig): Promise<PlayerAPI> {
  const { Player } = await loadBitmovinPlayer();
  return new Player(container, config);
}

export interface BitmovinBrowserBuildOptions {
  outdir?: string;
  assetBaseURL: string;
  minify?: boolean;
}

export async function buildBitmovinBrowser(options: BitmovinBrowserBuildOptions) {
  const assetBase = new URL(options.assetBaseURL);
  if (!/^https?:$/.test(assetBase.protocol)) throw new Error("assetBaseURL must use HTTP or HTTPS.");
  if (!assetBase.pathname.endsWith("/")) assetBase.pathname += "/";
  const bundle = await Bun.build({
    entrypoints: [import.meta.path],
    target: "browser",
    format: "esm",
    minify: options.minify ?? false,
    ...(options.outdir ? { outdir: options.outdir } : {}),
    naming: "bitmovin-bun.js",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Bitmovin browser bundle failed");
  const installedEntry = Bun.resolveSync("bitmovin-player", import.meta.dir);
  const packageRoot = installedEntry.slice(
    0,
    Math.max(installedEntry.lastIndexOf("/"), installedEntry.lastIndexOf("\\")),
  );
  const assets: { path: string; file: Blob }[] = [];
  for await (const path of new Bun.Glob("{*.js,*.css,THIRD_PARTY_NOTICES}").scan(packageRoot)) {
    const file = Bun.file(`${packageRoot}/${path}`);
    if (options.outdir) await Bun.write(`${options.outdir}/${path}`, file);
    assets.push({ path, file });
  }
  const location: LocationConfig = {
    ui: new URL("bitmovinplayer-ui.js", assetBase).href,
    ui_css: new URL("bitmovinplayer-ui.css", assetBase).href,
    serviceworker: new URL("bitmovinplayer-serviceworker.js", assetBase).href,
  };
  return { bundle, assets, location };
}
