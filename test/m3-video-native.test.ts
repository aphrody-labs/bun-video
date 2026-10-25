import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChromiumFrameContext } from "../src/chromium-frame";
import { prepareM3Video, m3VideoDocument, rasterizeM3SVG, renderM3Video } from "../src/m3-video";
import { encodeFilmCraftFrames } from "../src/encode";

const executable = Bun.env.BUN_VIDEO_NATIVE_EXECUTABLE;
const chromium = Bun.env.BUN_VIDEO_CHROMIUM_EXECUTABLE;

test.skipIf(!executable)(
  "native export cancellation releases a stalled frame producer",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bun-m3-abort-"));
    const controller = new AbortController();
    const reason = new Error("caller cancelled the stalled producer");
    const frames = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            queueMicrotask(() => controller.abort(reason));
            return new Promise<IteratorResult<{ data: Uint8Array; width: number; height: number }>>(() => {});
          },
          return() {
            return new Promise<IteratorResult<{ data: Uint8Array; width: number; height: number }>>(() => {});
          },
        };
      },
    };
    try {
      const output = join(directory, "cancelled.mp4");
      await expect(
        encodeFilmCraftFrames(frames, {
          nativeExecutable: executable!,
          output,
          width: 2,
          height: 2,
          frames: 1,
          fps: { num: 24, den: 1 },
          signal: controller.signal,
        }),
      ).rejects.toThrow(reason.message);
      expect(await Bun.file(output).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);

test.skipIf(!executable || !chromium)(
  "SVG → native M3 PNG → frame capture → FilmCraft MP4 → Bun.Video",
  async () => {
    expect(Bun.Video.available).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "bun-m3-native-"));
    const signal = AbortSignal.timeout(180000);
    let html = '<!doctype html><meta charset="utf-8"><script>window.showcaseReady=true</script>';
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      const setup = await openChromiumFrameContext({ url, width: 320, height: 180, executable: chromium!, signal });
      let plan;
      try {
        for (const svg of [
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/logo.png"/></svg>',
          '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.invalid/paint)"/></svg>',
          '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>',
        ]) {
          await expect(
            rasterizeM3SVG(new TextEncoder().encode(svg), setup.context, { width: 32, height: 32, signal }),
          ).rejects.toThrow();
        }
        plan = await prepareM3Video(
          {
            kind: "logo",
            label: "Native Material 3",
            format: "svg",
            bytes: new TextEncoder().encode(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffffff" d="M8 8h48v48H8z"/></svg>',
            ),
          },
          {
            seed: "#7850a8",
            width: 320,
            height: 180,
            frames: 24,
            fps: { num: 24, den: 1 },
            svgContext: setup.context,
            signal,
          },
        );
        expect(plan.asset?.dataURL).toStartWith("data:image/png;base64,");
      } finally {
        await setup.close();
      }
      html = m3VideoDocument(plan);
      const browser = await openChromiumFrameContext({
        url,
        width: plan.width,
        height: plan.height,
        executable: chromium!,
        signal,
      });
      try {
        const output = join(directory, "m3-native.mp4");
        const receipt = await renderM3Video(plan, {
          context: browser.context,
          compositionURL: url,
          nativeExecutable: executable!,
          output,
          signal,
        });
        expect(receipt.provider).toBe("filmcraft");
        expect(receipt.frames).toBe(24);
        expect(receipt.lossless).toBe(false);
        const video = new Bun.Video(output);
        const metadata = await video.metadata();
        expect(metadata.width).toBe(320);
        expect(metadata.height).toBe(180);
        const first = await video.frame(0).rgba();
        const last = await video.frame(23 / 24).rgba();
        expect(first.data.byteLength).toBe(320 * 180 * 4);
        expect(Bun.hash(first.data)).not.toBe(Bun.hash(last.data));
      } finally {
        await browser.close();
      }
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  210000,
);
