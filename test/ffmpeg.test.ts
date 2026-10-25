import { describe, expect, test } from "bun:test";
import { ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { FFmpeg, ffmpegABI, ffmpegLibraryPath } from "../src/ffmpeg";
import { openVideoPipeline } from "../src/pipeline";
import { materializeVideoSource, resolveVideoSource } from "../src/source";
import { mediaSDKLibraryDirectory, mediaSDKPlan, mediaSDKPrefix, validateSDKAsset } from "../src/sdk";
import { mediaSDKHostTarget } from "../src/sdk-platform";
import { dirname, join } from "node:path";

describe("media SDK identities", () => {
  test("installed SDK paths share Bun's home and preserve explicit library directories", () => {
    const target = mediaSDKHostTarget();
    expect(mediaSDKPrefix("ffmpeg")).toBe(join(dirname(process.execPath), "lib/media", "ffmpeg", target));
    expect(mediaSDKPrefix("mpv")).toBe(join(dirname(process.execPath), "lib/media", "mpv", target));
    expect(mediaSDKLibraryDirectory("ffmpeg", dirname(process.execPath))).toBe(dirname(process.execPath));
    expect(() => mediaSDKLibraryDirectory("ffmpeg", "relative")).toThrow("must be absolute");
  });
  test("FFmpeg SDKs have immutable asset digests and complete shared builds", () => {
    for (const target of ["windows-x64", "linux-x64"] as const) {
      const plan = mediaSDKPlan("ffmpeg", target);
      expect(plan.sourceRevision).toBe("7e93014c5bbb61e7c22afebb478bf92f7a08d59a");
      expect(plan.assets).toHaveLength(0);
      expect(plan.upstreamAssets).toHaveLength(1);
      expect(() => validateSDKAsset(plan.upstreamAssets![0])).not.toThrow();
      expect(plan.upstreamAssets![0].url).toContain("lgpl-shared-9.0");
      plan.upstreamAssets!.length = 0;
      expect(mediaSDKPlan("ffmpeg", target).upstreamAssets).toHaveLength(1);
    }
  });
  test("unqualified Linux mpv SDK stays explicitly unavailable", () => {
    expect(mediaSDKPlan("mpv", "linux-x64").assets).toHaveLength(0);
    expect(mediaSDKPlan("mpv", "linux-x64").libraryName).toBe("libmpv.so.2");
    expect(mediaSDKPlan("mpv", "windows-x64").libraryName).toBe("libmpv-2.dll");
  });
  test("SDK sources reject credentials, mutable digests and oversized assets", () => {
    const asset = mediaSDKPlan("ffmpeg", "windows-x64").upstreamAssets![0];
    for (const patch of [
      { url: "https://user:secret@example.test/a.zip" },
      { sha256: "latest" },
      { bytes: 536870913 },
      { format: "exe" },
    ])
      expect(() => validateSDKAsset({ ...asset, ...patch })).toThrow();
  });
});

function wavSample(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, "RIFF");
  view.setUint32(4, 38, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2, true);
  return bytes;
}

test("source normalization preserves paths and byte view boundaries", () => {
  expect(resolveVideoSource("clips/example.mp4")).toEqual({ kind: "file", path: "clips/example.mp4" });
  expect(resolveVideoSource("C:\\clips\\example.mp4")).toEqual({ kind: "file", path: "C:\\clips\\example.mp4" });
  const path = process.platform === "win32" ? "C:\\clips\\space name.mp4" : "/clips/space name.mp4";
  expect(resolveVideoSource(Bun.pathToFileURL(path))).toEqual({ kind: "file", path });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const source = resolveVideoSource(new DataView(bytes.buffer, 1, 2));
  expect(source.kind).toBe("bytes");
  if (source.kind !== "bytes" || !(source.data instanceof Uint8Array)) throw new Error("Expected byte view");
  expect([...source.data]).toEqual([2, 3]);
  expect(source.data.buffer).toBe(bytes.buffer);
  expect(() => resolveVideoSource("javascript:alert(1)")).toThrow("Unsupported video source protocol");
});

test.skipIf(typeof Bun.Video !== "function")(
  "native Video facade ingests a Response and delegates fluent state without opening media",
  async () => {
    const { createVideo } = await import("../src/pipeline");
    const source = new Uint8Array([1, 2, 3]);
    const video = await createVideo(new Response(source), { maxPixels: 4 });
    expect(video).toBeInstanceOf(Bun.Video);
    expect(video.frame(0).resize(2, 2).png()).toBe(video);
    expect(video.width).toBe(-1);
    expect(video.height).toBe(-1);
    const controller = new AbortController();
    controller.abort(new Error("stop video ingestion"));
    await expect(createVideo(new Response(source), { signal: controller.signal })).rejects.toThrow(
      "stop video ingestion",
    );
    await expect(createVideo(new Response(source, { status: 404 }))).rejects.toThrow("Media response failed (404)");
  },
);

test("FFmpeg requires an absolute native library directory", () => {
  expect(() => ffmpegLibraryPath("avcodec", "relative")).toThrow("must be absolute");
});

test("response ingestion retains binary data and honors cancellation", async () => {
  const source = await materializeVideoSource(new Response(new Uint8Array([1, 2, 3])));
  expect(source.kind).toBe("bytes");
  if (source.kind !== "bytes" || !(source.data instanceof Uint8Array)) throw new Error("Expected byte view");
  expect([...source.data]).toEqual([1, 2, 3]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled media ingestion"));
  await expect(materializeVideoSource(new Blob([new Uint8Array([1])]), controller.signal)).rejects.toThrow(
    "cancelled media ingestion",
  );
});

describe.skipIf(!process.env.BUN_VIDEO_MEDIA_DIR)("native FFmpeg ownership", () => {
  test("encodes a decoded native frame and decodes its PNG packet without subprocesses", () => {
    using ffmpeg = FFmpeg.open(process.env.BUN_VIDEO_MEDIA_DIR);
    const header = new TextEncoder().encode("P6\n2 1\n255\n");
    const ppm = new Uint8Array(header.length + 6);
    ppm.set(header);
    ppm.set([255, 0, 0, 0, 0, 255], header.length);
    using input = ffmpeg.openMemory(ppm);
    using source = ffmpeg.allocatePacket();
    using decoder = ffmpeg.openDecoder("ppm");
    using frame = ffmpeg.allocateFrame();
    expect(ffmpeg.readPacket(input, source)).toBe(true);
    expect(decoder.sendPacket(source)).toBe("ok");
    expect(decoder.receiveFrame(frame)).toBe("ok");
    using encoder = ffmpeg.openEncoder("png", {
      video_size: "2x1",
      pixel_format: "rgb24",
      time_base: "1/1",
      threads: "1",
    });
    using encoded = ffmpeg.allocatePacket();
    expect(encoder.receivePacket(encoded)).toBe("again");
    expect(encoder.sendFrame(frame)).toBe("ok");
    expect(encoder.receivePacket(encoded)).toBe("ok");
    using pngDecoder = ffmpeg.openDecoder("png");
    using restored = ffmpeg.allocateFrame();
    expect(pngDecoder.sendPacket(encoded)).toBe("ok");
    expect(pngDecoder.receiveFrame(restored)).toBe("ok");
    // AVFrame.data is the first field; this RGB24 fixture has one six-byte row.
    const pixels = read.ptr(restored.pointer) as Pointer;
    expect(pixels).toBeGreaterThan(0);
    expect([...new Uint8Array(toArrayBuffer(pixels, 0, 6))]).toEqual([255, 0, 0, 0, 0, 255]);
    expect(encoder.sendFrame(null)).toBe("ok");
    expect(encoder.receivePacket(encoded)).toBe("eof");
    expect(() => ffmpeg.openEncoder("missing-bun-video-encoder")).toThrow("encoder not found");
    expect(() => ffmpeg.openEncoder("png", { "bad\0": "value" })).toThrow("without NUL");
    expect(() =>
      ffmpeg.openEncoder("png", {
        video_size: "2x1",
        pixel_format: "rgb24",
        time_base: "1/1",
        threads: "1",
        unknown_bun_video_option: "1",
      }),
    ).toThrow("not recognized");
    ffmpeg.close();
    expect(() => encoder.pointer).toThrow("encoder is closed");
    expect(() => encoder.sendFrame(null)).toThrow("encoder is closed");
    expect(() => encoder.receivePacket(encoded)).toThrow("encoder is closed");
  });

  test("owns decoder contexts and preserves draining and flush states", () => {
    using ffmpeg = FFmpeg.open(process.env.BUN_VIDEO_MEDIA_DIR);
    using decoder = ffmpeg.openDecoder("h264");
    using frame = ffmpeg.allocateFrame();
    expect(decoder.pointer).toBeGreaterThan(0);
    expect(decoder.receiveFrame(frame)).toBe("again");
    expect(decoder.sendPacket(null)).toBe("ok");
    expect(decoder.receiveFrame(frame)).toBe("eof");
    expect(decoder.sendPacket(null)).toBe("eof");
    decoder.flush();
    expect(decoder.receiveFrame(frame)).toBe("again");
    expect(() => ffmpeg.openDecoder("missing-bun-video-decoder")).toThrow("decoder not found");
    expect(() => ffmpeg.openDecoder("ffv1\0")).toThrow("NUL");
    ffmpeg.close();
    expect(() => decoder.pointer).toThrow("decoder is closed");
    expect(() => decoder.sendPacket(null)).toThrow("decoder is closed");
    expect(() => decoder.receiveFrame(frame)).toThrow("decoder is closed");
    expect(() => decoder.flush()).toThrow("decoder is closed");
  });

  test("pipeline opens a native WAV source and closes its demuxer", async () => {
    const { openVideoPipeline } = await import("../src/pipeline");
    const bytes = wavSample();
    for (const source of [
      `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`,
      bytes,
      new Blob([bytes]),
      new Response(bytes),
    ]) {
      using pipeline = await openVideoPipeline({
        source,
        mediaDirectory: process.env.BUN_VIDEO_MEDIA_DIR,
        webgpu: false,
      });
      using packet = pipeline.ffmpeg.allocatePacket();
      expect(pipeline.gpuRuntime).toBeNull();
      if (typeof source === "string") {
        using configured = pipeline.ffmpeg.openInput(source, { probesize: "32", analyzeduration: "0" });
        using configuredPacket = pipeline.ffmpeg.allocatePacket();
        expect(pipeline.ffmpeg.readPacket(configured, configuredPacket)).toBe(true);
        expect(pipeline.ffmpeg.readPacket(configured, configuredPacket)).toBe(false);
      }
      expect(pipeline.ffmpeg.findStream(pipeline.input, "audio")).toBe(0);
      expect(() => pipeline.ffmpeg.findStream(pipeline.input, "video")).toThrow("FFmpeg:");
      expect(pipeline.ffmpeg.readPacket(pipeline.input, packet)).toBe(true);
      expect(pipeline.ffmpeg.readPacket(pipeline.input, packet)).toBe(false);
      pipeline.ffmpeg.seek(pipeline.input, 0n);
      expect(pipeline.ffmpeg.readPacket(pipeline.input, packet)).toBe(true);
      expect(pipeline.ffmpeg.readPacket(pipeline.input, packet)).toBe(false);
      expect(() => pipeline.ffmpeg.seek(pipeline.input, 1n << 63n)).toThrow("signed 64-bit bigint");
      pipeline.close();
      expect(() => pipeline.input.pointer).toThrow("FFmpeg input is closed");
    }
  });

  test("loads every declared symbol and owns frames and packets until disposal", () => {
    const ffmpeg = FFmpeg.open(process.env.BUN_VIDEO_MEDIA_DIR);
    try {
      for (const component of Object.keys(ffmpegABI) as Array<keyof typeof ffmpegABI>) {
        for (const name of Object.keys(ffmpegABI[component])) {
          expect(typeof (ffmpeg.libraries[component].symbols as Record<string, unknown>)[name]).toBe("function");
        }
      }
      const frame = ffmpeg.allocateFrame();
      const packet = ffmpeg.allocatePacket();
      const util = ffmpeg.libraries.avutil.symbols;
      expect(() => ffmpeg.openInput("unused", { "bad\0": "value" })).toThrow("without NUL");
      expect(() => ffmpeg.openInput("unused", { probesize: "32\0" })).toThrow("without NUL");
      const rgba = util.av_get_pix_fmt(ptr(new TextEncoder().encode("rgba\0")));
      expect(rgba).toBeGreaterThanOrEqual(0);
      expect(util.av_image_get_buffer_size(rgba, 16, 16, 1)).toBe(1024);
      expect(ffmpeg.libraries.swscale.symbols.sws_isSupportedInput(rgba)).toBe(1);
      expect(ffmpeg.libraries.swscale.symbols.sws_isSupportedOutput(rgba)).toBe(1);
      const sample = util.av_get_sample_fmt(ptr(new TextEncoder().encode("s16\0")));
      expect(util.av_get_bytes_per_sample(sample)).toBe(2);
      expect(util.av_sample_fmt_is_planar(sample)).toBe(0);
      expect(frame.pointer).toBeGreaterThan(0);
      expect(packet.pointer).toBeGreaterThan(0);
      frame.unref();
      packet.unref();
      ffmpeg.close();
      expect(() => frame.pointer).toThrow("frame is closed");
      expect(() => packet.pointer).toThrow("packet is closed");
      expect(() => ffmpeg.libraries).toThrow("FFmpeg is closed");
      frame.close();
      packet.close();
      ffmpeg.close();
    } finally {
      ffmpeg.close();
    }
  });
});

test.skipIf(!process.env.BUN_VIDEO_GPU_LIBRARY || !process.env.BUN_VIDEO_MEDIA_DIR)(
  "native pipeline retains its GPU provider for exact RGBA compute and closes it",
  async () => {
    using pipeline = await openVideoPipeline({
      source: wavSample(),
      mediaDirectory: process.env.BUN_VIDEO_MEDIA_DIR,
      webgpu: { libraryPath: process.env.BUN_VIDEO_GPU_LIBRARY },
    });
    expect(pipeline.gpu?.selected).not.toBeNull();
    const gpu = pipeline.gpuRuntime!;
    expect(gpu.closed).toBe(false);
    const pixels = new Uint32Array([0xff030201, 0x00000000, 0xff000000, 0x80ffffff]);
    const expected = [...pixels].map(pixel => (pixel ^ 0x00ffffff) >>> 0);
    const result = await gpu.wgsl({
      shader: `
@group(0) @binding(0) var<storage, read_write> rgba: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&rgba)) { rgba[id.x] = rgba[id.x] ^ 0x00ffffffu; }
}`,
      workgroups: [1, 1, 1],
      data: pixels,
    });
    expect([...new Uint32Array(result.data.buffer, result.data.byteOffset, pixels.length)]).toEqual(expected);
    pipeline.close();
    expect(gpu.closed).toBe(true);
    expect(() => pipeline.input.pointer).toThrow("FFmpeg input is closed");
  },
);
