import { describe, expect, test } from "bun:test";
import { readPageLayers } from "../src/page-layers";

describe("page layers", () => {
  test("reads the stacking layers of a rendered local page", async () => {
    const html = `<!doctype html><title>layers</title><style>.hero{position:fixed;z-index:10}.fade{opacity:.5}</style>
      <div class="hero" id="h"></div><div class="fade"></div><p>plain</p>`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    try {
      const view = new Bun.WebView({ width: 800, height: 600 });
      await view.navigate(`http://127.0.0.1:${server.port}/`);
      const report = await readPageLayers(view);
      view.close();
      expect(report.title).toBe("layers");
      expect(report.inlineStyleBlocks).toBe(1);
      const hero = report.layers.find(l => l.id === "h");
      expect(hero?.position).toBe("fixed");
      expect(hero?.zIndex).toBe("10");
      expect(report.layers.some(l => l.opacity === "0.5")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
