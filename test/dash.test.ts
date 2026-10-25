// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  attachDashPlayback,
  getDashBrowserAssetPath,
  inspectDashManifest,
  type DashPlaybackInstance,
} from "../src/dash";

const video = {} as HTMLVideoElement;
function mockPlayer(calls: string[]): DashPlaybackInstance {
  return {
    on() {},
    off() {},
    initialize(_video, _source, autoplay) {
      calls.push(`initialize:${autoplay}`);
    },
    updateSettings() {
      calls.push("settings");
    },
    setProtectionData() {
      calls.push("protection");
    },
    addRequestInterceptor() {
      calls.push("interceptor");
    },
    reset() {
      calls.push("reset");
    },
  };
}

test("DASH registers configuration and listeners before initializing; cleanup is idempotent", async () => {
  const calls: string[] = [];
  const player = mockPlayer(calls);
  const data = { "com.widevine.alpha": { serverURL: "https://licenses.example.test" } };
  player.setProtectionData = supplied => {
    expect(supplied).toBe(data);
    calls.push("protection");
  };
  const playback = await attachDashPlayback(video, {
    src: "https://media.example.test/manifest.mpd",
    createPlayer: () => player,
    settings: {},
    protectionData: data,
    requestInterceptor: async request => request,
    beforeStart: () => {
      calls.push("listeners");
    },
  });
  playback.destroy();
  playback.destroy();
  expect(calls).toEqual(["settings", "protection", "interceptor", "listeners", "initialize:false", "reset"]);
});

test("startup failure resets once and preserves the original exception even when reset throws", async () => {
  const calls: string[] = [];
  const player = mockPlayer(calls);
  player.initialize = () => {
    throw new Error("startup failed");
  };
  player.reset = () => {
    calls.push("reset");
    throw new Error("reset failed");
  };
  await expect(
    attachDashPlayback(video, {
      src: "https://media.example.test/m.mpd",
      createPlayer: () => player,
    }),
  ).rejects.toThrow("startup failed");
  expect(calls).toEqual(["reset"]);
});

test("async listener setup is rejected before initialization", async () => {
  const calls: string[] = [];
  await expect(
    attachDashPlayback(video, {
      src: "https://media.example.test/m.mpd",
      createPlayer: () => mockPlayer(calls),
      beforeStart: async () => {},
    }),
  ).rejects.toThrow("listeners synchronously");
  expect(calls).toEqual(["reset"]);
});

test("unsafe sources fail before factory creation and server attachment requires a factory", async () => {
  for (const src of ["file:///manifest.mpd", "https://user:password@example.test/m.mpd", "/relative.mpd"]) {
    await expect(
      attachDashPlayback(video, {
        src,
        createPlayer: () => {
          throw new Error("factory must not run");
        },
      }),
    ).rejects.toThrow("DASH source");
  }
  await expect(attachDashPlayback(video, { src: "https://media.example.test/m.mpd" })).rejects.toThrow(
    "browser media element",
  );
});

test("MPD inspection understands namespace prefixes, inherited codecs, relative bases and templates", () => {
  const metadata = inspectDashManifest(
    `<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S"><d:BaseURL>../video/</d:BaseURL><d:Period><d:AdaptationSet codecs="avc1.640028"><d:SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4"/><d:Representation width="1920" height="1080" bandwidth="4000000"/></d:AdaptationSet></d:Period></d:MPD>`,
  );
  expect(metadata).toEqual({
    kind: "dash",
    namespace: "urn:mpeg:dash:schema:mpd:2011",
    type: "static",
    duration: "PT12S",
    periodCount: 1,
    representations: [{ width: 1920, height: 1080, bandwidth: 4000000, codecs: "avc1.640028" }],
    baseUrlCount: 1,
    segmentTemplateCount: 1,
    encrypted: false,
    contentProtectionSystems: [],
  });
});

test("encrypted metadata identifies systems without retaining keys, PSSH or signed URLs", () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="secret-marker"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>secret-marker</cenc:pssh></ContentProtection><BaseURL>https://media.example.test/?token=secret-marker</BaseURL><Representation codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;
  const metadata = inspectDashManifest(xml);
  expect(metadata.encrypted).toBe(true);
  expect(metadata.contentProtectionSystems).toEqual(["CommonEncryption", "Widevine"]);
  expect(JSON.stringify(metadata)).not.toContain("secret-marker");
});

test("invalid XML, foreign namespace, and DTD declarations are rejected", () => {
  for (const xml of [
    "<MPD><Period></MPD>",
    '<MPD xmlns="urn:foreign"/>',
    '<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///secret">]><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">&x;</MPD>',
  ])
    expect(() => inspectDashManifest(xml)).toThrow();
});

test("browser UMD asset resolves without evaluating dashjs in Bun", async () => {
  const path = getDashBrowserAssetPath();
  expect(path).toMatch(/umd[/\\]dash\.all\.min\.js$/);
  expect(await Bun.file(path).exists()).toBe(true);
});
