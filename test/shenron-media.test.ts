import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  encodeSlideshow,
  findFFmpeg,
  qualifyCorpus,
  qualifyImage,
  readBack,
  slideshowFrame,
} from "../scripts/qualify-shenron-media";

const corpus = Bun.env.SHENRON_CORPUS ?? "/home/ubuntu/src/shenron";
const hasCorpus = existsSync(corpus);
const videoAvailable = !!(Bun as any).Video?.available;
const ffmpeg = findFFmpeg();

// Minimal PNG writer for synthesized RGBA (Bun.Image has no raw-pixel constructor).
function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

const synth = (i: number) =>
  rgbaPng(96 + i * 16, 64, (x, y) => [(x * 7 + i * 40) & 255, (y * 5) & 255, (i * 60) & 255, 255]);

describe("hermetic synthesized media", () => {
  test("Bun.Image decodes, resizes and encodes synthesized RGBA", async () => {
    const png = synth(1);
    const meta = await new Bun.Image(png).metadata();
    expect(meta).toMatchObject({ width: 112, height: 64, format: "png" });

    // Lossless round trip keeps the synthesized pixel pattern.
    const roundTrip = await new Bun.Image(await new Bun.Image(png).webp({ lossless: true } as any).bytes())
      .png()
      .bytes();
    expect(await new Bun.Image(roundTrip).metadata()).toMatchObject({ width: 112, height: 64, format: "png" });

    for (const fmt of ["webp", "jpeg"] as const) {
      const out = await new Bun.Image(png).resize(56, 32)[fmt]().bytes();
      expect(await new Bun.Image(out).metadata()).toMatchObject({ width: 56, height: 32, format: fmt });
    }
    // AVIF encode needs an AV1 encoder in the runtime build; report rather than assume.
    const avif = await new Bun.Image(png)
      .avif()
      .bytes()
      .then(
        b => b,
        e => e as Error,
      );
    if (avif instanceof Error) expect(avif.message).toContain("not supported");
    else expect(await new Bun.Image(avif).metadata()).toMatchObject({ width: 112, height: 64, format: "avif" });
  });

  test("slideshow frames are resized to a fixed size", async () => {
    const frame = await slideshowFrame(synth(3));
    expect(await new Bun.Image(frame).metadata()).toMatchObject({ width: 320, height: 240, format: "png" });
  });

  test.skipIf(!ffmpeg)("encodes an MP4 slideshow and reads it back with Bun.Video", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shenron-synth-"));
    try {
      const frames = await Promise.all([0, 1, 2, 3, 4, 5].map(i => slideshowFrame(synth(i))));
      const out = join(dir, "synth.mp4");
      const { bytes } = await encodeSlideshow(frames, out, 2);
      expect(bytes).toBeGreaterThan(1000);
      const rb = await readBack(out, frames.length, 2);
      if (!videoAvailable) {
        expect(rb).toMatchObject({ available: false });
        return;
      }
      expect(rb.error).toBeUndefined();
      expect(rb.metadata).toMatchObject({ width: 320, height: 240 });
      expect(rb.metadata!.duration).toBeCloseTo(3, 0);
      expect(rb).toMatchObject({ frameWidth: 160, frameHeight: 120, frameFormat: "webp", frames: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasCorpus)("Shenron corpus", () => {
  test("bounded sample decodes and transcodes", async () => {
    const report = await qualifyCorpus(corpus, { limit: 24, slides: 6 });
    expect(report.discovered).toBeGreaterThan(100);
    expect(report.sampled).toBe(24);
    expect(report.decoded / report.sampled).toBeGreaterThan(0.9);
    expect(Object.keys(report.formats).length).toBeGreaterThan(0);
    for (const f of ["webp", "jpeg"]) expect(report.encodeBytes[f]).toBeGreaterThan(0);
    expect(report.encodeBytes.avif > 0 || report.encodeFailures.avif?.count === report.decoded).toBe(true);
    if (ffmpeg) {
      expect(report.slideshow?.error).toBeUndefined();
      expect(report.slideshow!.frames).toBe(6);
      if (videoAvailable) {
        expect(report.readback).toMatchObject({ available: true, frames: 6, frameWidth: 160, frameHeight: 120 });
        expect(report.readback!.metadata).toMatchObject({ width: 320, height: 240 });
      }
    }
  }, 120_000);

  test("individual corpus image reports real dimensions", async () => {
    const { paths } = await (await import("../scripts/qualify-shenron-media")).sampleImages(corpus, 3);
    for (const p of paths) {
      const r = await qualifyImage(p, ["webp"]);
      if (!r.ok) continue;
      expect(r.width!).toBeGreaterThan(0);
      expect(r.height!).toBeGreaterThan(0);
      expect(r.encoded!.webp).toBeGreaterThan(0);
    }
  });
});
