import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowsPEImports, windowsMediaDependencies } from "../scripts/media-plugin";

function image(imports: string[]): Uint8Array {
  const bytes = Buffer.alloc(2048);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(16, 0x98 + 108);
  bytes.writeUInt32LE(imports.length ? 0x1000 : 0, 0x98 + 112 + 8);
  bytes.writeUInt32LE(1536, 0x188 + 8);
  bytes.writeUInt32LE(0x1000, 0x188 + 12);
  bytes.writeUInt32LE(1536, 0x188 + 16);
  bytes.writeUInt32LE(512, 0x188 + 20);
  imports.forEach((name, index) => {
    bytes.writeUInt32LE(0x1200 + index * 64, 512 + index * 20 + 12);
    bytes.write(name + "\0", 1024 + index * 64, "ascii");
  });
  return bytes;
}

test("PE dependencies resolve import names through the image section table", () => {
  expect(windowsPEImports(image(["AVCODEC-63.dll", "KERNEL32.dll"]))).toEqual(["avcodec-63.dll", "kernel32.dll"]);
  expect(() => windowsPEImports(new Uint8Array([0]))).toThrow("PE");
});

test("Windows media package includes only the transitive allowlisted adjacent DLLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-media-imports-"));
  try {
    const ffmpeg = join(root, "ffmpeg.exe"),
      ffprobe = join(root, "ffprobe.exe");
    await Bun.write(ffmpeg, image(["avcodec-63.dll", "kernel32.dll"]));
    await Bun.write(ffprobe, image(["avcodec-63.dll"]));
    await Bun.write(join(root, "avcodec-63.dll"), image(["zlib1.dll"]));
    await Bun.write(join(root, "zlib1.dll"), image([]));
    await Bun.write(join(root, "unrelated.dll"), image([]));
    expect(await windowsMediaDependencies(ffmpeg, ffprobe)).toEqual([
      join(root, "avcodec-63.dll"),
      join(root, "zlib1.dll"),
    ]);
    await rm(join(root, "zlib1.dll"));
    await expect(windowsMediaDependencies(ffmpeg, ffprobe)).rejects.toThrow("missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
