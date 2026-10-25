import { describe, expect, test } from "bun:test";
import { prepareM3Video, m3VideoFrameSVG, m3VideoDocument, m3IconSVG, rasterizeM3SVG } from "../src/m3-video";

describe("native M3 video planning", () => {
  test("prompts remain explicit deterministic typography with canonical Material roles", async () => {
    const first = await prepareM3Video({ kind: "prompt", text: "Bun <native> & Material 3" }, { seed: "#7850a8" });
    const second = await prepareM3Video({ kind: "prompt", text: "Bun <native> & Material 3" }, { seed: "#7850a8" });
    expect(first).toEqual(second);
    expect(first.interpretation).toBe("typography");
    expect(first.roles["--md-sys-color-primary"]).toMatch(/^#[a-f\d]{6}$/i);
    const start = m3VideoFrameSVG(first, 0),
      end = m3VideoFrameSVG(first, first.frames - 1);
    expect(start).toContain('id="m3-scene" opacity="0"');
    expect(end).toContain('id="m3-scene" opacity="1"');
    expect(end).toContain("Bun &lt;native&gt; &amp;");
    expect(end).not.toContain("<native>");
    expect(m3VideoFrameSVG(first, 48)).toBe(m3VideoFrameSVG(second, 48));
    expect(() => m3VideoFrameSVG(first, 96)).toThrow("outside");
  });

  test("rejects over-budget plans and unsupported SVG capability before decoding", async () => {
    await expect(
      prepareM3Video({ kind: "text", text: "Bun" }, { seed: "#7850a8", width: 1920, height: 1080, frames: 96 }),
    ).rejects.toThrow("budget");
    await expect(prepareM3Video({ kind: "text", text: "Bun" }, { seed: "red" })).rejects.toThrow("six-digit");
    await expect(
      prepareM3Video(
        {
          kind: "logo",
          label: "Bun",
          bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          format: "svg",
        },
        { seed: "#7850a8" },
      ),
    ).rejects.toThrow("browser context");
  });

  test("generated document escapes content and exposes the existing seek protocol", async () => {
    const plan = await prepareM3Video(
      { kind: "text", text: "</script><script>alert(1)</script>" },
      { seed: "#7850a8" },
    );
    const document = m3VideoDocument(plan);
    expect(document).not.toContain("<script>alert(1)");
    expect(document).toContain("window.__hf=");
    expect(document).toContain("window.showcaseReady=true");
    expect(document).not.toContain('src="https:');
  });

  test("normalizes raster logos with Bun.Image before creating M3 icon artwork", async () => {
    const bytes = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42IAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const plan = await prepareM3Video({ kind: "logo", label: "Bun", bytes, format: "raster" }, { seed: "#7850a8" });
    expect(plan.interpretation).toBe("logo-reveal");
    expect(plan.asset?.width).toBe(512);
    expect(plan.asset?.height).toBe(512);
    expect(plan.asset?.dataURL).toStartWith("data:image/png;base64,");
    expect(m3IconSVG(plan)).toContain('width="512" height="512" rx="144"');
  });

  test("SVG document entities never reach the browser", async () => {
    let evaluated = false;
    const context = {
      navigate: async () => {},
      screenshot: async () => new Uint8Array(),
      evaluate: async <T>() => {
        evaluated = true;
        return "" as T;
      },
    };
    await expect(
      rasterizeM3SVG(new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg/>'), context, {
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow("entities");
    expect(evaluated).toBe(false);
  });
});
