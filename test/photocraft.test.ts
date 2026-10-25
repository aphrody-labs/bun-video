import { expect, test } from "bun:test";
import { createPhotoCraftImageTransform, createPhotoCraftSVGRasterizer } from "../src/photocraft";

const options = { executable: "/missing/photocraft-cli", temporaryDirectory: "/tmp/bun-video-photocraft" };

test("PhotoCraft bridge refuses ambient paths and unbounded work before launching", async () => {
  expect(() => createPhotoCraftImageTransform({ ...options, executable: "photocraft-cli" })).toThrow("absolute");
  expect(() => createPhotoCraftImageTransform({ ...options, timeoutMs: Infinity })).toThrow("timeout");
  const convert = createPhotoCraftImageTransform(options);
  await expect(convert(new Uint8Array())).rejects.toThrow("1 byte to 32 MiB");
  await expect(convert(new Uint8Array(32 * 1024 * 1024 + 1))).rejects.toThrow("1 byte to 32 MiB");
  await expect(convert(new Uint8Array([1]), AbortSignal.abort())).rejects.toThrow();
  const rasterize = createPhotoCraftSVGRasterizer(options);
  await expect(rasterize(new Uint8Array([1]), { width: 0, height: 512 })).rejects.toThrow("4096");
});

const executable = Bun.env.BUN_VIDEO_PHOTOCRAFT_CLI;
test.skipIf(!executable)("PhotoCraft SVG importer produces a bounded native Bun.Image raster", async () => {
  const rasterize = createPhotoCraftSVGRasterizer({
    executable: executable!,
    temporaryDirectory: Bun.env.TMPDIR ?? "/tmp",
  });
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#ff0000"/></svg>',
  );
  const result = await rasterize(bytes, { width: 64, height: 64 });
  const image = await new Bun.Image(result).rgba();
  expect([image.width, image.height]).toEqual([64, 32]);
  expect(Array.from(image.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
});
