import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VideoCatalog } from "../src/video-catalog";
import { createVideoDataSite } from "../src/video-data-site";

test("actual loopback HTTP exposes allowlisted rows and blocks cross-origin writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "video-data-site-"));
  using catalog = new VideoCatalog(":memory:");
  catalog.registerSource({ id: "public-source", privateRef: join(root, "private-cookie.har") });
  const site = await createVideoDataSite({
    catalog,
    privateRoot: root,
    initialize: false,
    runner: async input => ({
      output: input.output,
      engine: input.engine,
      sourcePath: input.source.value,
      compositionEntry: input.source.value,
      frames: 1,
      sha256: "00".repeat(32),
      bytes: 1,
    }),
  });
  try {
    const overview = await fetch(new URL("api/overview", site.url));
    expect(overview.status).toBe(200);
    expect((await overview.json()).cache.redis).toBe("disabled");
    const body = JSON.stringify({ table: "sources" });
    const denied = await fetch(new URL("api/query", site.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.crunchyroll.com" },
      body,
    });
    expect(denied.status).toBe(403);
    const allowed = await fetch(new URL("api/query", site.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(site.url).origin },
      body,
    });
    expect(allowed.status).toBe(200);
    const response = await allowed.json();
    expect(response.rows[0].id).toBe("public-source");
    expect(JSON.stringify(response)).not.toContain("private-cookie");
    const privateQuery = await fetch(new URL("api/query", site.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(site.url).origin },
      body: JSON.stringify({ table: "sources", columns: ["privateRef"] }),
    });
    expect(privateQuery.status).toBe(400);
    expect(JSON.stringify(await privateQuery.json())).not.toContain(root);
    const exported = await fetch(new URL("api/export", site.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(site.url).origin },
      body: JSON.stringify({ format: "json" }),
    });
    expect(exported.status).toBe(201);
    const item = await exported.json();
    expect(item.output).toBeUndefined();
    const download = await fetch(new URL(`api/exports/${item.id}`, site.url));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).not.toContain("private-cookie");
    const queued = await fetch(new URL("api/jobs", site.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(site.url).origin },
      body: JSON.stringify({
        jobs: [
          {
            source: { kind: "file", value: join(root, "fixture.mp4") },
            engine: "remotion",
            output: join(root, "render.mp4"),
            width: 320,
            height: 180,
            fps: 30,
            durationFrames: 1,
            frameWorkers: 1,
          },
        ],
      }),
    });
    expect(queued.status).toBe(202);
    const receipt = await queued.json();
    expect(receipt.ids).toHaveLength(1);
    expect(catalog.getJob(receipt.ids[0])).not.toBeNull();
  } finally {
    await site.close();
    rmSync(root, { recursive: true, force: true });
  }
});
