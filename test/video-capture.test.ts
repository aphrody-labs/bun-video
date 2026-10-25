import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoCatalog } from "../src/video-catalog";
import { importCapturedVideoNetwork } from "../src/video-capture";

test("extracts all asset kinds and preserves DRM/range limits without public credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "video-capture-"));
  try {
    const input = join(root, "input.har");
    const output = join(root, "capture");
    const entry = (
      path: string,
      mime: string,
      text: string,
      status = 200,
      headers: { name: string; value: string }[] = [],
      encoding?: string,
    ) => ({
      request: {
        url: `https://www.crunchyroll.com/assets/cenc/${path}?signed=private`,
        method: "GET",
        headers: [{ name: "Cookie", value: "private-cookie" }],
      },
      response: { status, headers, content: { mimeType: mime, text, ...(encoding ? { encoding } : {}) } },
    });
    const mpd =
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="v"/></AdaptationSet></Period></MPD>';
    const raw = JSON.stringify({
      log: {
        pages: [{ id: "page" }],
        entries: [
          entry("page.html", "text/html", "<html></html>"),
          entry("app.js", "application/javascript", "const n=1"),
          entry("style.css", "text/css", "body{}"),
          entry("video.mpd", "application/dash+xml", mpd),
          entry(
            "video.mp4",
            "application/octet-stream",
            Buffer.from([1, 2, 3]).toString("base64"),
            206,
            [{ name: "Content-Range", value: "bytes 0-2/100" }],
            "base64",
          ),
          entry("config.json", "application/json", '{"token":"private-token"}'),
        ],
      },
    });
    await Bun.write(input, raw);
    using catalog = new VideoCatalog(":memory:");
    const summary = await importCapturedVideoNetwork(input, { catalog, outputDirectory: output });
    expect(summary.entries).toBe(6);
    expect(summary.bodyCount).toBe(6);
    expect(summary.encryptedManifestCount).toBe(1);
    expect(summary.mediaCount).toBe(1);
    expect(summary.incompleteMediaCount).toBe(1);
    expect(summary.clearCompleteMediaCount).toBe(0);
    expect(await Bun.file(input).text()).toBe(raw);
    const index = await Bun.file(summary.captureIndexPath).json();
    expect(index.requests[4].range.received).toBe("bytes 0-2/100");
    expect(index.requests[4].complete).toBe(false);
    expect(index.requests[4].encrypted).toBe(true);
    expect([...(await Bun.file(join(output, index.requests[4].bodyFile)).bytes())]).toEqual([1, 2, 3]);
    const rows = catalog.db.query("SELECT * FROM capture_entries").all();
    const stored = JSON.stringify(rows);
    expect(rows).toHaveLength(6);
    expect(stored).not.toContain("private-cookie");
    expect(stored).not.toContain("signed=");
    expect(stored).not.toContain("private-token");
    expect(catalog.db.query("SELECT * FROM captured_resources").all()).toHaveLength(6);
    await expect(importCapturedVideoNetwork(input, { outputDirectory: output })).rejects.toThrow("already exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
