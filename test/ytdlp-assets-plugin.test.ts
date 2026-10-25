import { expect, test } from "bun:test";
import { ytDlpVendorAssets, ytDlpAssetsPlugin } from "../scripts/ytdlp-assets-plugin";

test("standalone yt-dlp inventory contains the canonical Python owners and shipped Bun solver", async () => {
  const entries = await ytDlpVendorAssets();
  const names = entries.map(entry => entry.path);
  expect(names).toContain("yt_dlp/__init__.py");
  expect(names).toContain("yt_dlp/version.py");
  expect(names).toContain("yt_dlp/extractor/youtube/jsc/_builtin/vendor/yt.solver.bun.lib.js");
  expect(names.every(name => !/(^|\/)(?:__pycache__|tests?|node_modules)(\/|$)/.test(name))).toBe(true);
  expect(entries.find(entry => entry.path === "yt_dlp/extractor/youtube/jsc/_builtin/__init__.py")?.bytes).toBe(0);
  expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeGreaterThan(8 * 1024 * 1024);
});

test("vendor namespace generates lazy extraction and checks the exact owned cleanup path", async () => {
  let loader: (() => Promise<{ contents: string }>) | undefined;
  ytDlpAssetsPlugin().setup({
    onResolve() {},
    onLoad(_options: unknown, callback: typeof loader) {
      loader = callback;
    },
  } as any);
  const module = await loader!();
  expect(module.contents).toContain("export const vendorRoot=mkdtempSync");
  expect(module.contents).toContain("dirname(target)!==parent");
  expect(module.contents).toContain("readFileSync(asset");
  expect(module.contents).not.toContain("__pycache__");
  expect(module.contents).not.toContain("cookie.json");
});
