import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  autoFps,
  autoFpsFocus,
  cleanWatch,
  evenIndices,
  filterRange,
  formatTime,
  frameDelta,
  parseCaptions,
  parseTime,
  parseTimestamps,
  renderReport,
  selectCaption,
  watch,
} from "../src/watch";

const fixture = join(import.meta.dir, "../hyperframes/player/tests/perf/fixtures/10-video-grid/sample.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;

describe("watch time and budgets", () => {
  test("parses SS, MM:SS and HH:MM:SS and rejects malformed times", () => {
    expect(parseTime("90")).toBe(90);
    expect(parseTime("1:30")).toBe(90);
    expect(parseTime("1:01:01")).toBe(3661);
    expect(parseTime(" ")).toBeUndefined();
    for (const bad of ["1:60", "-1", "a", "1:2:3:4", "1.5:10"]) expect(() => parseTime(bad)).toThrow();
    expect(parseTimestamps("7:10, 4:32,,4:32")).toEqual([272, 430]);
    expect(formatTime(3725)).toBe("1:02:05");
  });

  test("auto budgets follow duration and never exceed 2 fps", () => {
    expect(autoFps(10)).toEqual([1.2, 12]);
    expect(autoFps(3600, 100)[1]).toBe(100);
    expect(autoFps(0)).toEqual([1, 1]);
    const [fps, target] = autoFpsFocus(4, 100);
    expect(fps).toBe(2);
    expect(target).toBe(8);
    expect(evenIndices(10, 4)).toEqual([0, 3, 6, 9]);
    expect(evenIndices(3, 9)).toEqual([0, 1, 2]);
  });

  test("frame delta treats size mismatches as different", () => {
    expect(frameDelta(new Uint8Array([0, 0]), new Uint8Array([4, 0]))).toBe(2);
    expect(frameDelta(new Uint8Array([0]), new Uint8Array([0, 0]))).toBe(Infinity);
  });
});

describe("watch captions", () => {
  test("parses VTT, strips tags and collapses rolling duplicates only", () => {
    const vtt = `WEBVTT

NOTE ignore me

00:00:01.000 --> 00:00:02.000 align:start
Hello <c>world</c> &amp; all

00:00:01.500 --> 00:00:03.000 align:start
Hello world &amp; all today

00:00:05.000 --> 00:00:06.000
again
00:00:07.000 --> 00:00:08.000
again
`;
    const segments = parseCaptions(vtt);
    expect(segments).toEqual([
      { start: 1, end: 3, text: "Hello world & all today" },
      { start: 5, end: 6, text: "again" },
      { start: 7, end: 8, text: "again" },
    ]);
    expect(filterRange(segments, 4, 6)).toHaveLength(1);
  });

  test("parses SRT timestamps with commas", () => {
    expect(parseCaptions("1\n00:00:01,250 --> 00:00:02,000\nhi\n")).toEqual([{ start: 1.25, end: 2, text: "hi" }]);
  });

  test("selects the original automatic track before translations", () => {
    const track = (ext = "vtt") => [{ ext, url: "https://example.test/c.vtt" }];
    const info = {
      extractor_key: "Youtube",
      subtitles: {},
      automatic_captions: { en: track(), "fr-orig": track(), fr: track() },
    };
    expect(selectCaption(info)).toMatchObject({
      key: "fr-orig",
      language: "fr",
      kind: "automatic",
      provenance: "original",
    });
    expect(selectCaption({ ...info, subtitles: { de: track() } }, "en")).toMatchObject({
      language: "en",
      provenance: "requested translation",
    });
    expect(selectCaption({ subtitles: {}, automatic_captions: {} })).toBeNull();
  });
});

describe.skipIf(!nativeVideo?.available)("watch native pipeline", () => {
  test("extracts timestamped JPEG frames and cue frames without FFmpeg", async () => {
    const report = await watch({
      source: fixture,
      detail: "efficient",
      maxFrames: 6,
      resolution: 160,
      timestamps: [2.5],
    });
    try {
      expect(report.errors).toEqual([]);
      expect(report.durationSeconds).toBeCloseTo(10, 0);
      expect(report.width).toBe(480);
      expect(report.frames.length).toBeLessThanOrEqual(6);
      expect(report.frames.some(f => f.reason === "transcript-cue" && f.timestampSeconds === 2.5)).toBe(true);
      const times = report.frames.map(f => f.timestampSeconds);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const first = Bun.file(report.frames[0]!.path);
      const bytes = new Uint8Array(await first.slice(0, 3).arrayBuffer());
      expect([...bytes]).toEqual([0xff, 0xd8, 0xff]);
      expect(renderReport(report)).toContain("## Frames");
    } finally {
      await cleanWatch(report);
    }
  });

  test("honors a focus range and transcript-only detail", async () => {
    const focused = await watch({ source: fixture, detail: "balanced", start: 2, end: 4, resolution: 96 });
    try {
      expect(focused.focus).toEqual({ start: 2, end: 4 });
      expect(focused.frames.length).toBeGreaterThan(0);
      for (const frame of focused.frames) {
        expect(frame.timestampSeconds).toBeGreaterThanOrEqual(2);
        expect(frame.timestampSeconds).toBeLessThan(4);
      }
    } finally {
      await cleanWatch(focused);
    }
    const textOnly = await watch({ source: fixture, detail: "transcript", whisper: "none" });
    try {
      expect(textOnly.frames).toEqual([]);
      expect(textOnly.transcriptState).toBe("fallback disabled; no captions available");
    } finally {
      await cleanWatch(textOnly);
    }
  });

  test("rejects an invalid range and a missing file", async () => {
    await expect(watch({ source: fixture, start: 5, end: 5 })).rejects.toThrow("end must be greater than start");
    await expect(watch({ source: fixture, start: 99 })).rejects.toThrow("past end of video");
    await expect(watch({ source: join(import.meta.dir, "missing.mp4") })).rejects.toThrow("File not found");
  });
});
