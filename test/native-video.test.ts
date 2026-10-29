import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { Video, splitPngStream } from "../src/native-video";
import { decodePngToRgba } from "../src/png-decode";

const source = resolve(import.meta.dir, "../hyperframes/cli/src/commands/__fixtures__/silent.mp4");
const scratch = mkdtempSync(join(tmpdir(), "bun-video-native-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("documented upstream APIs only: no fork Bun.Video is required", () => {
  expect(typeof Bun.Image).toBe("function");
  expect(typeof Bun.spawn).toBe("function");
});

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x]!;
      const a = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      raw[y * (stride + 1) + 1 + x] = (v - predictor) & 255;
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, Bun.hash.crc32(out.subarray(4, 8 + body.length)) >>> 0);
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return Uint8Array.from([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

test("png decoder reverses all five scanline filters", () => {
  const width = 7, height = 10;
  const pixels = new Uint8Array(width * height * 4).map((_, i) => (i * 37 + (i >> 3) * 11) & 255);
  const decoded = decodePngToRgba(encodePng(width, height, pixels));
  expect([decoded.width, decoded.height, decoded.channels]).toEqual([width, height, 4]);
  expect(decoded.data).toEqual(pixels);
  expect(() => decodePngToRgba(new Uint8Array(40))).toThrow("Not a PNG");
});

describe.skipIf(!Video.available)("spawn-backed Video (FFmpeg/FFprobe on PATH or BUN_VIDEO_FFMPEG)", () => {
  test("metadata", async () => {
    const meta = await new Video(source).metadata();
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(90);
    expect(meta.codec).toBe("h264");
    expect(meta.frameCount).toBe(15);
    expect(meta.fpsDenominator).toBeGreaterThan(0);
    expect(meta.fileBytes).toBe(readFileSync(source).length);
  });

  test("frame -> resize -> webp bytes and raw RGBA", async () => {
    const video = new Video(source);
    const webp = await video.frame(0).resize(80, 45).webp({ lossless: true }).bytes();
    expect(new TextDecoder().decode(webp.subarray(0, 4))).toBe("RIFF");
    const pixels = await video.frame(0).resize(32, 18, { fit: "fill" }).rgba();
    expect(pixels.width).toBe(32);
    expect(pixels.height).toBe(18);
    expect(pixels.channels).toBe(4);
    expect(pixels.data.length).toBe(32 * 18 * 4);
    expect(pixels.data.some(v => v !== 0)).toBe(true);
  });

  test("extract crops before the other transforms", async () => {
    const pixels = await new Video(source).frame(0).extract({ left: 10, top: 10, width: 40, height: 20 }).rgba();
    expect([pixels.width, pixels.height]).toEqual([40, 20]);
  });

  test("Bun.Image.rgba shim matches the video frame decoder", async () => {
    const png = await new Video(source).frame(0).png().bytes();
    const viaImage = await (new Bun.Image(png) as unknown as { rgba(): Promise<{ data: Uint8Array }> }).rgba();
    const direct = decodePngToRgba(png);
    expect(viaImage.data).toEqual(direct.data);
  });

  test("bounded frame batch is split into whole PNGs", async () => {
    const batch = await new Video(source).frames({ start: 0, end: 0.5, step: 0.125, maxFrames: 4 });
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThanOrEqual(4);
    for (const { bytes } of batch) expect(decodePngToRgba(bytes).width).toBe(160);
    expect(splitPngStream(new Uint8Array([...batch[0]!.bytes, ...batch[0]!.bytes])).length).toBe(2);
  });

  test("in-memory source is materialised, probed and cleaned up", async () => {
    using video = new Video(new Uint8Array(readFileSync(source)));
    expect((await video.metadata()).width).toBe(160);
  });

  test("gif, remux and hls", async () => {
    const video = new Video(source);
    const gif = await video.gif({ start: 0, duration: 0.5, fps: 8, width: 64 });
    expect(new TextDecoder().decode(gif.subarray(0, 3))).toBe("GIF");
    const out = join(scratch, "remux.mkv");
    await video.remux(out);
    expect((await new Video(out).metadata()).container).toBe("matroska");
    await expect(video.remux(out)).rejects.toThrow("already exists");
    const hls = await video.hls(join(scratch, "hls"), { segmentSeconds: 1 });
    expect(readFileSync(hls.playlist, "utf8")).toContain("#EXTM3U");
    expect(hls.segments.length).toBe(readdirSync(join(scratch, "hls")).filter(f => f.endsWith(".ts")).length);
  });

  test("rejects invalid ranges and oversized frames", async () => {
    const video = new Video(source);
    expect(() => video.frame(-1)).toThrow(RangeError);
    await expect(video.frames({ start: 0, end: 1, step: 0.1, maxFrames: 65 })).rejects.toThrow(RangeError);
    await expect(new Video(source, { maxPixels: 10 }).metadata()).rejects.toThrow("maxPixels");
  });
});
