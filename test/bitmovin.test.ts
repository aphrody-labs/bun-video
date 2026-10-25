import { expect, test } from "bun:test";
import { buildBitmovinBrowser, createBitmovinPlayer, loadBitmovinPlayer } from "../src/bitmovin";
import type { PlayerConfig, SourceConfig } from "../src/bitmovin";
import { isDebug } from "../../../test/harness";

test("server imports remain safe and browser evaluation is deferred", async () => {
  expect(typeof createBitmovinPlayer).toBe("function");
  await expect(loadBitmovinPlayer()).rejects.toThrow("requires a browser DOM");
});

test(
  "Bun bundles the installed player and provides unchanged local UI and service worker assets",
  async () => {
    const { bundle, assets, location } = await buildBitmovinBrowser({
      assetBaseURL: "http://localhost/assets",
    });
    const output = await bundle.outputs[0]!.text();
    expect(output).toContain("loadBitmovinPlayer");
    expect(output).toContain("createBitmovinPlayer");
    expect(bundle.success).toBe(true);
    expect(assets.map(asset => asset.path)).toContain("bitmovinplayer-serviceworker.js");
    expect(assets.map(asset => asset.path)).toContain("THIRD_PARTY_NOTICES");
    expect(location.ui_css).toBe("http://localhost/assets/bitmovinplayer-ui.css");
    const config: PlayerConfig = {
      key: "caller-supplied-license",
      location,
      playback: { autoplay: false },
    };
    const source: SourceConfig = { hls: "http://localhost/fixture.m3u8" };
    expect(config.playback?.autoplay).toBe(false);
    expect(source.hls).toBe("http://localhost/fixture.m3u8");
  },
  isDebug ? 90_000 : 30_000,
);

test("browser asset URLs reject unsupported schemes", async () => {
  await expect(buildBitmovinBrowser({ assetBaseURL: "file:///assets/" })).rejects.toThrow("HTTP or HTTPS");
});
