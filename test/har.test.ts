// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { CapturedHar, loadHarCapture } from "../src/har";

const manifest =
  '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><BaseURL>video.mp4?token=secret-marker</BaseURL><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation codecs="avc1.640028"/></AdaptationSet></Period></MPD>';
function entry(url: string, mimeType: string, text: string, status = 200, range?: string, contentRange?: string) {
  return {
    request: {
      method: "GET",
      url,
      headers: [{ name: "Cookie", value: "secret-marker" }, ...(range ? [{ name: "Range", value: range }] : [])],
    },
    response: {
      status,
      headers: [
        { name: "Set-Cookie", value: "secret-marker" },
        ...(contentRange ? [{ name: "Content-Range", value: contentRange }] : []),
      ],
      content: { mimeType, text },
    },
  };
}
const capture = (...entries: ReturnType<typeof entry>[]) => new CapturedHar({ log: { entries } });

test("HAR summary and manifest selection contain metadata without credential or URL details", () => {
  const har = capture(entry("https://media.example.test/m.mpd?token=secret-marker", "application/dash+xml", manifest));
  expect(har.selectManifest({ kind: "dash" })?.entryIndex).toBe(0);
  expect(har.summary.manifests[0]?.metadata).toMatchObject({
    encrypted: true,
    contentProtectionSystems: ["Widevine"],
  });
  expect(JSON.stringify(har.summary)).not.toContain("secret-marker");
  expect(JSON.stringify(har)).not.toContain("secret-marker");
  expect(har.readManifest(0)).toBe(manifest);
  expect(har.summary.playbackValidated).toBe(false);
});

test("captured 206 media replay preserves exact binary bytes and safe range headers", async () => {
  const resource = entry(
    "https://media.example.test/video.mp4?token=secret-marker",
    "application/octet-stream",
    Buffer.from([0, 255, 1, 128]).toString("base64"),
    206,
    "bytes=4-7",
    "bytes 4-7/100",
  );
  const har = new CapturedHar({
    log: {
      entries: [
        {
          ...resource,
          response: {
            ...resource.response,
            content: { ...resource.response.content, encoding: "base64" },
          },
        },
      ],
    },
  });
  const opaque = har.resourceForUrl(resource.request.url)!;
  expect(JSON.stringify(opaque)).not.toContain("secret-marker");
  const response = har.replayResource(opaque.entryIndex, "bytes=4-7")!;
  expect(response.status).toBe(206);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 128]));
  expect(response.headers.get("content-range")).toBe("bytes 4-7/100");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(har.replayResource(opaque.entryIndex, "bytes=8-11")).toBeNull();
  const subset = har.replayResource(opaque.entryIndex, "bytes=5-6")!;
  expect(new Uint8Array(await subset.arrayBuffer())).toEqual(new Uint8Array([255, 1]));
  expect(subset.headers.get("content-range")).toBe("bytes 5-6/100");
  expect(har.replayResource(opaque.entryIndex, "bytes=3-8")).toBeNull();
  expect(har.replayResource(opaque.entryIndex)).toBeNull();
});

test("complete captured bodies support bounded, open and suffix ranges without fetching", async () => {
  const har = capture(entry("https://media.example.test/video.mp4", "video/mp4", "0123456789"));
  const url = "https://media.example.test/video.mp4";
  expect(await har.replay(url, "bytes=2-4")!.text()).toBe("234");
  expect(await har.replay(url, "bytes=8-")!.text()).toBe("89");
  expect(await har.replay(url, "bytes=-3")!.text()).toBe("789");
  expect(har.replay(url, "bytes=100-200")!.status).toBe(416);
  expect(har.replay(url, "bytes=0-1,4-5")).toBeNull();
  expect(har.replay("https://other.example.test/video.mp4")).toBeNull();
});

test("invalid partial bodies and license/API responses cannot be replayed", () => {
  const har = capture(
    entry("https://media.example.test/video.mp4", "video/mp4", "short", 206, "bytes=0-9", "bytes 0-9/100"),
    entry("https://media.example.test/license.mp4", "application/octet-stream", "license-secret"),
    entry("https://www.crunchyroll.com/api", "application/json", '{"token":"secret-marker"}'),
  );
  expect(har.replay("https://media.example.test/video.mp4", "bytes=0-9")).toBeNull();
  expect(har.resourceForUrl("https://media.example.test/license.mp4")).toBeNull();
  expect(har.resourceForUrl("https://www.crunchyroll.com/api")).toBeNull();
  expect(har.summary.jsonResponses).toBe(1);
});

test("invalid captured XML and malformed JSON are counted and never exposed", () => {
  const har = capture(
    entry("https://media.example.test/m.mpd", "application/dash+xml", "<MPD>secret-marker"),
    entry("https://media.example.test/api", "application/json", "secret-marker"),
  );
  expect(har.summary.invalidManifestResponses).toBe(1);
  expect(har.summary.invalidJsonResponses).toBe(1);
  expect(har.selectManifest()).toBeUndefined();
  expect(() => har.readManifest(0)).toThrow("validated captured manifest");
  expect(JSON.stringify(har.summary)).not.toContain("secret-marker");
});

test("HLS manifests are classified without retaining key or segment URLs", () => {
  const har = capture(
    entry(
      "https://media.example.test/m.m3u8",
      "application/vnd.apple.mpegurl",
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="secret-marker"\n#EXTINF:2,\nsecret-marker.ts\n',
    ),
  );
  expect(har.selectManifest({ kind: "hls" })?.metadata).toEqual({
    kind: "hls",
    encrypted: true,
    segmentCount: 1,
    variantCount: 0,
  });
  expect(JSON.stringify(har.summary)).not.toContain("secret-marker");
});

test("loader requires an absolute path and malformed HAR errors omit raw details", async () => {
  await expect(loadHarCapture("relative.har")).rejects.toThrow("absolute");
  expect(() => new CapturedHar({ log: { entries: [{ request: { url: "secret-marker" } }] } })).toThrow(
    "Invalid HAR entry structure.",
  );
});
