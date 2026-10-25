// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { attachVideoHlsPlayback, getHlsBrowserAssetPath, getHlsPublicAssets } from "../src/hls";
import { normalizeCookieExport, cookieHeader, validateHlsConfig } from "../src/apps/hls-live-core";

test("French Crunchyroll episode accepts a private session without treating the watch page as a manifest", () => {
  const pageUrl = "https://www.crunchyroll.com/fr/watch/GE00389313JAJP/the-god-who-destroys";
  const config = validateHlsConfig({ src: null, pageUrl, config: { enableWorker: false } });
  expect(config.src).toBeNull();
  expect(config.pageUrl).toBe(pageUrl);
  const bundle = normalizeCookieExport([
    {
      domain: ".crunchyroll.com",
      hostOnly: false,
      name: "session-fixture",
      value: "synthetic",
      path: "/",
      secure: true,
      httpOnly: true,
      session: true,
      sameSite: "no_restriction",
    },
  ]);
  expect(cookieHeader(bundle.chromium, new URL(pageUrl))).toBe("session-fixture=synthetic");
  expect(cookieHeader(bundle.chromium, new URL("https://unrelated.example.test"))).toBe("");
});

test("HLS package serves its pinned decoder and rejects server playback", async () => {
  const path = getHlsBrowserAssetPath();
  expect(path.replaceAll("\\", "/")).toEndWith("/hls.min.js");
  expect(await Bun.file(path).exists()).toBe(true);
  const assets = await getHlsPublicAssets();
  expect(assets.version).toBe("1.7.3");
  expect(await Bun.file(assets.worker).exists()).toBe(true);
  expect(await Bun.file(assets.license).text()).toContain("2017 Dailymotion");
  await expect(
    attachVideoHlsPlayback({} as HTMLVideoElement, { src: "https://media.example.test/a.m3u8" }),
  ).rejects.toThrow("browser video element");
});
