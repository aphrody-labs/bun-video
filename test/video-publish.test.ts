import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoCatalog } from "../src/video-catalog";
import { exportPublicVideoCatalog, validateVideoPublicationTarget } from "../src/video-publish";

test("portable catalog strips private paths, credentials and job configuration", () => {
  const work = mkdtempSync(join(tmpdir(), "video-publish-"));
  const catalog = new VideoCatalog(join(work, "private.sqlite"));
  try {
    catalog.registerSource({
      id: "source",
      url: "https://www.crunchyroll.com/",
      kind: "url",
      privateRef: "C:/secret/cookies.json",
    });
    const output = join(work, "public.sqlite");
    const result = exportPublicVideoCatalog(catalog, output);
    expect(result.records).toBeGreaterThan(0);
    const publicDB = new Database(output, { readonly: true });
    try {
      expect(publicDB.query("SELECT * FROM sources").get()).toEqual({ id: "source", providerId: null, kind: "url" });
      expect(
        publicDB
          .query<{ name: string }, []>("PRAGMA table_info(sources)")
          .all()
          .map(row => row.name),
      ).toEqual(["id", "providerId", "kind"]);
      expect(publicDB.query("SELECT name FROM sqlite_master WHERE name='secrets'").get()).toBeNull();
    } finally {
      publicDB.close();
    }
    expect(() => exportPublicVideoCatalog(catalog, output)).toThrow();
  } finally {
    catalog.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("publication rejects object-service and r2.dev URLs and unsafe prefixes", () => {
  expect(validateVideoPublicationTarget("aphrody-dist", "bun-video", "https://dist.aphrody.app")).toBe(
    "https://dist.aphrody.app",
  );
  for (const url of [
    "https://private.r2.dev",
    "https://account.r2.cloudflarestorage.com",
    "https://dist.aphrody.app/path",
    "http://dist.aphrody.app",
    "https://user:pass@dist.aphrody.app",
  ])
    expect(() => validateVideoPublicationTarget("aphrody-dist", "bun-video", url)).toThrow();
  expect(() => validateVideoPublicationTarget("aphrody-dist", "../cookies", "https://dist.aphrody.app")).toThrow();
});
