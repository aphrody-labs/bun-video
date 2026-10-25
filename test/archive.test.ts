import { expect, test } from "bun:test";
import { compressVideoBytes, createVideoArchive, decompressVideoBytes, writeVideoArchive } from "../src/archive";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Bun.Archive media packaging preserves the requested tar, tar.gz and zip container", async () => {
  for (const format of ["tar", "tar.gz", "zip"] as const) {
    const bytes = await createVideoArchive(
      { "manifest.json": '{"episode":1}', "frames/1.txt": "native archive" },
      format,
      { mtime: 0 },
    ).bytes();
    if (format === "zip") expect([...bytes.subarray(0, 2)]).toEqual([80, 75]);
    else if (format === "tar.gz") expect([...bytes.subarray(0, 2)]).toEqual([31, 139]);
    else expect([...bytes.subarray(0, 2)]).not.toEqual([31, 139]);
    const files = await new Bun.Archive(bytes).files();
    expect(files.size).toBe(2);
    expect(await files.get("frames/1.txt")!.text()).toBe("native archive");
  }
});

test("every advertised media compression format roundtrips through its matching decoder", async () => {
  const value = "Bun Video — 日本語 — français".repeat(20);
  for (const format of ["gzip", "zstd", "brotli", "deflate"] as const) {
    const compressed = await compressVideoBytes(value, format);
    expect((await decompressVideoBytes(compressed, format)).toString()).toBe(value);
  }
});

test("archive file inputs preserve lazily loaded Bun.File and Blob contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-archive-test-"));
  try {
    await Bun.write(join(root, "source.txt"), "file-backed asset");
    const path = join(root, "output.tar.gz");
    await writeVideoArchive(path, {
      "source.txt": Bun.file(join(root, "source.txt")),
      "blob.txt": new Blob(["blob asset"]),
    });
    const entries = await new Bun.Archive(await Bun.file(path).arrayBuffer()).files();
    expect(await entries.get("source.txt")!.text()).toBe("file-backed asset");
    expect(await entries.get("blob.txt")!.text()).toBe("blob asset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
