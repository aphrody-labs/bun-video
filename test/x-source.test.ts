import { describe, expect, test } from "bun:test";
import { normalizeXVideoUrl, XVideoSource } from "../src/x-source";

describe("X video source adapter", () => {
  test("canonicalizes public status URLs to an ID-only X extractor URL", () => {
    expect(normalizeXVideoUrl("https://www.twitter.com/example/status/123456789?s=20&t=secret#video")).toEqual({
      statusId: "123456789",
      url: "https://x.com/i/web/status/123456789",
    });
    expect(normalizeXVideoUrl("https://x.com/i/web/status/987654321/video/1").statusId).toBe("987654321");
  });

  test("rejects non-status URLs, hostile lookalikes, and credentials", () => {
    for (const url of [
      "https://x.com/home",
      "https://x.com.evil.example/user/status/123",
      "https://user:secret@x.com/user/status/123",
      "https://t.co/abc",
      "file:///x.com/user/status/123",
    ])
      expect(() => normalizeXVideoUrl(url)).toThrow();
  });

  test("delegates metadata extraction and download with the sanitized canonical URL", async () => {
    const calls: unknown[][] = [];
    const result = { id: "123", title: "public status" };
    const source = new XVideoSource({
      ytdlp: { format: "best" },
      extract: async (...args) => {
        calls.push(["extract", ...args]);
        return result;
      },
      download: async (...args) => {
        calls.push(["download", ...args]);
        return result;
      },
    });

    expect(await source.metadata("https://x.com/person/status/123?tracking=private")).toBe(result);
    expect(await source.download("https://x.com/person/status/123?tracking=private", "out.mp4")).toBe(result);
    expect(calls).toEqual([
      ["extract", "https://x.com/i/web/status/123", { no_playlist: true, format: "best" }],
      ["download", "https://x.com/i/web/status/123", "out.mp4", { no_playlist: true, format: "best" }],
    ]);
  });

  test("validates output before calling the downloader", async () => {
    let called = false;
    const source = new XVideoSource({
      download: async () => {
        called = true;
        return {};
      },
    });
    await expect(source.download("https://x.com/person/status/123", "")).rejects.toThrow("non-empty");
    expect(called).toBe(false);
  });
});
