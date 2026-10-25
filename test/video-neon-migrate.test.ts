import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoCatalog } from "../src/video-catalog";
import { importVideoCatalog, snapshotVideoCatalog, type VideoCatalogSql } from "../src/video-neon-migrate";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bun-video-neon-"));
  directories.push(directory);
  return join(directory, "video.sqlite");
}

test("captures a consistent catalog, including optional capture tables", () => {
  const path = fixture();
  using catalog = new VideoCatalog(path);
  catalog.registerProvider({ id: "fixture", name: "Fixture", family: "test" });
  const first = snapshotVideoCatalog(path);
  expect(first.counts.providers).toBe(1);
  expect(first.counts.capture_entries).toBe(0);
  expect(first.counts.video_site_exports).toBe(0);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);

  catalog.registerProvider({ id: "second", name: "Second", family: "test" });
  const second = snapshotVideoCatalog(path);
  expect(second.counts.providers).toBe(2);
  expect(second.digest).not.toBe(first.digest);
  expect(first.counts.providers).toBe(1);
});

test("refuses a changed snapshot before opening a Neon transaction", async () => {
  const path = fixture();
  using catalog = new VideoCatalog(path);
  catalog.registerProvider({ id: "fixture", name: "Fixture", family: "test" });
  const snapshot = snapshotVideoCatalog(path);
  let began = false;
  const sql: VideoCatalogSql = {
    async begin<T>(callback: (transaction: VideoCatalogSql) => T | Promise<T>): Promise<T> {
      began = true;
      return callback(sql);
    },
    async unsafe() {
      throw new Error("SQL must not run");
    },
  };
  snapshot.tables[0]!.rows[0]!.name = "tampered";
  await expect(importVideoCatalog(sql, snapshot)).rejects.toThrow("changed after capture");
  expect(began).toBe(false);
});
