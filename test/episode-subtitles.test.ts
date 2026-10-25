import { expect, test } from "bun:test";
import {
  capturedSubtitle,
  matchingEpisode,
  parseSubtitle,
  renderSubtitle,
  SubtitleTrackUnavailable,
} from "../scripts/episode-subtitles";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ASS conversion preserves dialogue commas, Unicode, line breaks and centisecond timing", () => {
  const cues = parseSubtitle(
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.23,0:00:03.45,Default,,0,0,0,,{\\i1}Bonjour, maître !\\NÉpisode & <texte>\nDialogue: 0,0:00:02.00,0:00:02.10,Default,,0,0,0,,{\\p1}m 0 0 l 1 1`,
    "ass",
  );
  expect(cues).toEqual([{ startMs: 1230, endMs: 3450, text: "Bonjour, maître !\nÉpisode & <texte>" }]);
  expect(renderSubtitle(cues, "srt")).toBe("1\n00:00:01,230 --> 00:00:03,450\nBonjour, maître !\nÉpisode & <texte>\n");
  expect(renderSubtitle(cues, "vtt")).toContain("Épisode &amp; &lt;texte&gt;");
});

test("Japanese acquisition accepts only an actually returned provider caption track", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-caption-test-"));
  try {
    const directory = join(root, "capture");
    const playback = {
      audioLocale: "ja-JP",
      subtitles: { "fr-FR": { format: "ass", url: "https://cdn.crunchyrollcdn.com/fr.ass" } },
      captions: { "ja-JP": { format: "vtt", url: "https://cdn.crunchyrollcdn.com/ja.vtt?signature=fixture-private" } },
      token: "fixture-private",
    };
    await Bun.write(
      join(directory, "episode.json"),
      JSON.stringify({
        data: [
          {
            id: "GE00389313JAJP",
            title: "Le dieu de la Destruction",
            episode_metadata: { series_title: "Dragon Ball Super: Beerus", episode_number: 1, duration_ms: 1397690 },
          },
        ],
      }),
    );
    await Bun.write(join(directory, "playback.json"), JSON.stringify(playback));
    await Bun.write(
      join(directory, "capture-index.json"),
      JSON.stringify({
        requests: [
          {
            kind: "json",
            bodyFile: "episode.json",
            response: { status: 200 },
            request: { url: "https://www.crunchyroll.com/content/v2/cms/objects/GE00389313JAJP" },
          },
          {
            kind: "json",
            bodyFile: "playback.json",
            response: { status: 200 },
            request: { url: "https://www.crunchyroll.com/playback/v3/GE00389313JAJP/web/chrome/play" },
          },
        ],
      }),
    );
    expect(await capturedSubtitle(root, "ja-JP")).toMatchObject({
      locale: "ja-JP",
      trackType: "caption",
      format: "vtt",
    });
    await Bun.write(join(directory, "playback.json"), JSON.stringify({ ...playback, captions: {} }));
    try {
      await capturedSubtitle(root, "ja-JP");
      throw new Error("Expected absent provider locale");
    } catch (error) {
      expect(error).toBeInstanceOf(SubtitleTrackUnavailable);
      expect((error as SubtitleTrackUnavailable).inspected).toEqual([
        {
          episodeId: "GE00389313JAJP",
          audioLocale: "ja-JP",
          subtitleLocales: ["fr-FR"],
          captionLocales: [],
          hardSubLocales: [],
        },
      ]);
      expect(JSON.stringify(error)).not.toContain("fixture-private");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VTT conversion handles cue identifiers, settings, notes and short timestamps", () => {
  const cues = parseSubtitle(
    "WEBVTT\n\nNOTE private annotation\nignore me\n\nintro\n01:02.500 --> 01:04.000 align:start\nBonjour\n",
    "vtt",
  );
  expect(cues).toEqual([{ startMs: 62500, endMs: 64000, text: "Bonjour" }]);
  expect(renderSubtitle(cues, "srt")).toContain("00:01:02,500 --> 00:01:04,000");
});

test("subtitle conversion rejects malformed or inverted timings", () => {
  expect(() => parseSubtitle("1\n00:61:00,000 --> 00:62:00,000\nText", "srt")).toThrow("timestamp");
  expect(() => parseSubtitle("1\n00:00:02,000 --> 00:00:01,000\nText", "srt")).toThrow("interval");
  expect(() => parseSubtitle("WEBVTT", "vtt")).toThrow("no dialogue");
});

test("episode match requires the actual title, series and episode number", () => {
  const row = {
    id: "GE00389313JAJP",
    title: "Le dieu de la Destruction",
    episode_metadata: {
      series_title: "Dragon Ball Super: Beerus",
      episode_number: 1,
      duration_ms: 1397690,
    },
  };
  expect(matchingEpisode({ data: [row] }, row.title, row.episode_metadata.series_title)?.id).toBe(row.id);
  expect(
    matchingEpisode(
      { data: [{ ...row, episode_metadata: { ...row.episode_metadata, episode_number: 2 } }] },
      row.title,
      row.episode_metadata.series_title,
    ),
  ).toBeUndefined();
  expect(matchingEpisode({ data: [row] }, row.title, "Dragon Ball Super")).toBeUndefined();
});
