import type { BunPlugin } from "bun";
import { VideoCatalog } from "../src/video-catalog";

/** Embed metadata from these exact source owners; compiled executables do not require source files. */
export function videoCatalogPlugin(): BunPlugin {
  return {
    name: "bun-video-catalog-inventory",
    setup(build) {
      build.onResolve({ filter: /^bun-video:catalog-inventory$/ }, () => ({
        path: "inventory",
        namespace: "video-catalog",
      }));
      build.onLoad({ filter: /.*/, namespace: "video-catalog" }, async () => {
        using catalog = new VideoCatalog(":memory:");
        await catalog.seedCapabilities();
        await catalog.importYtDlpProviders();
        return {
          loader: "js",
          contents: `export const capabilities=${JSON.stringify(catalog.listCapabilities())};export const providers=${JSON.stringify(catalog.listProviders())};`,
        };
      });
    },
  };
}
