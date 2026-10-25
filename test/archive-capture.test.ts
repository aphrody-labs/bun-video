import { expect, test } from "bun:test";
import { archiveCDXURL, captureArchiveHTTP } from "../src/archive-capture";

test("CDX queries preserve the selected real URL and bound snapshots", () => {
  const query = new URL(archiveCDXURL("https://www.crunchyroll.com/"));
  expect(query.origin).toBe("https://web.archive.org");
  expect(query.searchParams.get("url")).toBe("https://www.crunchyroll.com/");
  expect(query.searchParams.get("limit")).toBe("3");
  expect(query.searchParams.get("output")).toBe("json");
});

test("capture rejects origins and unbounded jobs before network I/O", async () => {
  await expect(captureArchiveHTTP({ url: "https://www.crunchyroll.com/" })).rejects.toThrow("archive.org");
  await expect(captureArchiveHTTP({ maxResources: 251 })).rejects.toThrow("bounds");
  await expect(captureArchiveHTTP({ cdxURLs: Array(4).fill("https://www.crunchyroll.com/") })).rejects.toThrow("three");
});
