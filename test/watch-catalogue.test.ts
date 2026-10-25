import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogue, watchCatalogue } from "../src/watch-catalogue";
import { readCaptionFile } from "../src/watch";

const fixture = join(import.meta.dir, "../hyperframes/player/tests/perf/fixtures/10-video-grid/sample.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "watch-catalogue-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("watch catalogue", () => {
  test("reads .ass captions into seconds", async () => {
    await withRoot(async root => {
      const path = join(root, "ep.ass");
      await Bun.write(
        path,
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Salut\n",
      );
      expect(await readCaptionFile(path)).toEqual([{ start: 1, end: 2.5, text: "Salut" }]);
    });
  });

  test("validates ids and lists a directory of videos", async () => {
    await withRoot(async root => {
      await Bun.write(join(root, "bad.json"), JSON.stringify([{ id: "../x", source: "a.mp4" }]));
      await expect(loadCatalogue(join(root, "bad.json"))).rejects.toThrow("Invalid catalogue id");
      await Bun.write(
        join(root, "dup.json"),
        JSON.stringify([
          { id: "a", source: "a" },
          { id: "a", source: "b" },
        ]),
      );
      await expect(loadCatalogue(join(root, "dup.json"))).rejects.toThrow("Duplicate");
      await Bun.write(join(root, "e02.mp4"), "x");
      await Bun.write(join(root, "e01.webm"), "x");
      await Bun.write(join(root, "notes.txt"), "x");
      expect((await loadCatalogue(root)).map(entry => entry.id)).toEqual(["e01", "e02"]);
    });
  });

  test.skipIf(!nativeVideo?.available)(
    "runs episodes concurrently, isolates failures and resumes from cache",
    async () => {
      await withRoot(async root => {
        const videos = join(root, "videos");
        await mkdir(videos);
        for (const id of ["ep001", "ep002"]) await copyFile(fixture, join(videos, `${id}.mp4`));
        await Bun.write(join(videos, "ep001.fr.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n");
        await Bun.write(join(videos, "ep003.mp4"), "not a video");
        const out = join(root, "out");
        const options = {
          out,
          concurrency: 2,
          detail: "efficient" as const,
          maxFrames: 5,
          resolution: 96,
          whisper: "none" as const,
        };
        const entries = await loadCatalogue(videos);

        const first = await watchCatalogue(entries, options);
        expect(first.map(r => [r.id, r.status])).toEqual([
          ["ep001", "done"],
          ["ep002", "done"],
          ["ep003", "failed"],
        ]);
        expect(first[0]!.transcriptSegments).toBe(1);
        expect(first[0]!.frames).toBeGreaterThan(0);
        expect(await Bun.file(join(out, "catalogue.json")).exists()).toBe(true);
        expect((await readdir(join(out, "ep001"))).sort()).toContain("watch.json");

        const second = await watchCatalogue(entries, options);
        expect(second.map(r => r.status)).toEqual(["cached", "cached", "failed"]);

        const changed = await watchCatalogue(entries.slice(0, 1), { ...options, maxFrames: 3 });
        expect(changed[0]!.status).toBe("done");
        expect((await readdir(join(out, "ep001"))).filter(name => name.startsWith("watch-"))).toHaveLength(1);
      });
    },
  );
});
