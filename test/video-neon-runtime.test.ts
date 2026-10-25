import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoCatalog } from "../src/video-catalog";
import { openConfiguredVideoCatalog } from "../src/video-neon-runtime";

test("cutover marker refuses SQLite fallback when Neon credentials are absent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-video-cutover-"));
  const prior = Bun.env.BUN_VIDEO_CATALOG_BACKEND;
  const options = {
    sqlitePath: join(directory, "video.sqlite"),
    cutoverMarker: join(directory, "neon.active"),
    connectionFile: join(directory, "neon.url"),
  };
  try {
    delete Bun.env.BUN_VIDEO_CATALOG_BACKEND;
    const local = await openConfiguredVideoCatalog(options);
    expect(local).toBeInstanceOf(VideoCatalog);
    await local.close();
    await Bun.write(options.cutoverMarker, "active\n");
    await expect(openConfiguredVideoCatalog(options)).rejects.toThrow("refuses a SQLite catalog path");
    Bun.env.BUN_VIDEO_CATALOG_BACKEND = "sqlite";
    await expect(openConfiguredVideoCatalog(options)).rejects.toThrow("forbids SQLite writers");
    Bun.env.BUN_VIDEO_CATALOG_BACKEND = "neon";
    expect(() => new VideoCatalog(join(directory, "bypass.sqlite"))).toThrow("forbids SQLite writers");
    delete Bun.env.BUN_VIDEO_CATALOG_BACKEND;
    await expect(openConfiguredVideoCatalog({ ...options, sqlitePath: undefined })).rejects.toThrow(
      "connection file is missing",
    );
  } finally {
    if (prior === undefined) delete Bun.env.BUN_VIDEO_CATALOG_BACKEND;
    else Bun.env.BUN_VIDEO_CATALOG_BACKEND = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});
