import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoWebApp } from "../src/web-app";

const fixture = join(import.meta.dir, "../hyperframes/player/tests/perf/fixtures/10-video-grid/sample.mp4");
const nativeVideo = (Bun as unknown as { Video?: { available: boolean } }).Video;

describe.skipIf(!nativeVideo?.available)("GET /api/video/watch", () => {
  test("returns timestamped inline frames for library media and rejects bad input", async () => {
    const root = await mkdtemp(join(tmpdir(), "web-watch-"));
    try {
      await copyFile(fixture, join(root, "clip.mp4"));
      const app = createVideoWebApp({ mediaRoot: root });
      const get = (query: string) => app.fetch(new Request(`http://localhost/api/video/watch?${query}`));

      const ok = await get("src=clip.mp4&detail=efficient&frames=4&width=96");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        durationSeconds: number;
        frames: { index: number; timestampSeconds: number; dataUrl: string }[];
        workDir?: string;
        localMedia?: string;
      };
      expect(body.durationSeconds).toBeCloseTo(10, 0);
      expect(body.frames.length).toBeGreaterThan(0);
      expect(body.frames.length).toBeLessThanOrEqual(4);
      expect(body.frames[0]!.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(body.workDir).toBeUndefined();
      expect(body.localMedia).toBeUndefined();

      expect((await get("src=..%2Fescape.mp4")).status).toBe(400);
      expect((await get("src=clip.mp4&detail=token-burner")).status).toBe(400);
      expect((await get("src=clip.mp4&frames=99")).status).toBe(400);
      expect((await get("src=missing.mp4")).status).toBe(422);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
