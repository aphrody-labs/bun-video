import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { VideoCatalog } from "../src/video-catalog";
import { importCapturedVideoNetwork } from "../src/video-capture";
import { queryVideoDataset, exportVideoDataset, createVideoDatasetCache } from "../src/video-dataset";

test("structured dataset queries protect private columns and bound pagination", () => {
  using catalog = new VideoCatalog(":memory:");
  catalog.registerSource({ id: "one", privateRef: "private/capture-index.json" });
  expect(queryVideoDataset(catalog, { table: "sources", where: { id: "one" } }).rows).toEqual([
    { id: "one", providerId: null, kind: "file" },
  ]);
  expect(() => queryVideoDataset(catalog, { table: "sources", columns: ["privateRef"] })).toThrow("private");
  expect(() => queryVideoDataset(catalog, { table: "sources", where: { url: "https://www.crunchyroll.com" } })).toThrow(
    "private",
  );
  expect(() => queryVideoDataset(catalog, { table: "sources", limit: 1001 })).toThrow("pagination");
});

test("curated text omits scripts/forms/tokens and SQL exports only generated tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "video-dataset-"));
  try {
    const har = join(root, "source.har");
    await Bun.write(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { url: "https://www.crunchyroll.com/news/article?token=private", method: "GET" },
              response: {
                status: 200,
                content: {
                  mimeType: "text/html",
                  text: '<html><head><title>Article</title><script>secret=script-secret</script></head><body><nav><p>private navigation</p></nav><article><h1>Title</h1><p>Hello world. token=hidden-token</p><a href="https://www.crunchyroll.com/news/next?signature=private">Next</a></article><form><p>private form</p></form></body></html>',
                },
              },
            },
          ],
        },
      }),
    );
    using catalog = new VideoCatalog(":memory:");
    await importCapturedVideoNetwork(har, { catalog, outputDirectory: join(root, "capture") });
    const result = await exportVideoDataset(catalog, {
      format: "json",
      output: join(root, "dataset.json"),
      includeText: true,
    });
    const json = await Bun.file(result.output).json();
    expect(json.documents).toHaveLength(1);
    expect(json.documents[0].text).toContain("Hello world.");
    const serialized = JSON.stringify(json);
    for (const privateValue of [
      "script-secret",
      "hidden-token",
      "private navigation",
      "private form",
      "signature=",
      "bodyRef",
      "privateRef",
    ])
      expect(serialized).not.toContain(privateValue);
    const sql = await exportVideoDataset(catalog, {
      format: "sql",
      output: join(root, "dataset.sql"),
      includeText: true,
    });
    using imported = new Database(":memory:");
    imported.exec(await Bun.file(sql.output).text());
    expect(imported.query("SELECT COUNT(*) AS n FROM curated_dataset_document").get()).toEqual({ n: 1 });
    expect(imported.query("SELECT name FROM sqlite_master WHERE name='sources'").get()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite dataset cache never claims Redis when none was explicitly configured", async () => {
  using store = createVideoDatasetCache({ sqlitePath: ":memory:" });
  expect(await store.probe()).toEqual({ sqlite: "ready", redis: "disabled" });
  await store.cache.set("public-query", { rows: [{ id: "safe" }] });
  expect(await store.cache.get("public-query")).toEqual({ rows: [{ id: "safe" }] });
  await expect(store.cache.set("private", { bodyRef: "private/raw.har" })).rejects.toThrow("Private");
  await store.cache.set("public-text", { text: "Bearer private-key-value" });
  expect(await store.cache.get("public-text")).toEqual({ text: "Bearer [redacted]" });
});
