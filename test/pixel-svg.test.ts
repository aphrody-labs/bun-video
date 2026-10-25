import { describe, expect, test } from "bun:test";
import { rgbaToPixelSVG } from "../src/pixel-svg";

describe("RGBA pixel paths", () => {
  test("horizontal runs share the exact RGBA colour across rows", () => {
    const pixels = new Uint8Array([
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    ]);
    const result = rgbaToPixelSVG(pixels, 3, 2, "<source & référence>");
    expect(result.colors).toBe(2);
    expect(result.runs).toBe(4);
    expect(result.pixels).toBe(6);
    expect(result.svg).toContain('<path fill="#ff0000" d="M0 0h2v1h-2zM1 1h2v1h-2z"/>');
    expect(result.svg).toContain('<path fill="#0000ff" d="M2 0h1v1h-1zM0 1h1v1h-1z"/>');
    expect(result.svg).toContain("&lt;source &amp; référence&gt;");
    expect(result.svg).not.toContain("<image");
    expect(result.svg).not.toContain("base64");
  });
  test("alpha is preserved separately and never palette-quantized", () => {
    const result = rgbaToPixelSVG(new Uint8Array([19, 37, 71, 128, 19, 37, 71, 127, 240, 30, 20, 0]), 3, 1);
    expect(result.colors).toBe(3);
    expect(result.runs).toBe(3);
    expect(result.svg).toContain(`fill="#132547" fill-opacity="${128 / 255}"`);
    expect(result.svg).toContain(`fill="#132547" fill-opacity="${127 / 255}"`);
    expect(result.svg).toContain('fill="#f01e14" fill-opacity="0"');
  });
  test("bounded dimensions and exact byte length", () => {
    for (const [width, height] of [
      [0, 1],
      [-1, 1],
      [1.5, 2],
      [257, 1],
      [1, 257],
      [Infinity, 1],
    ])
      expect(() => rgbaToPixelSVG(new Uint8Array(4), width!, height!)).toThrow(RangeError);
    expect(() => rgbaToPixelSVG(new Uint8Array(7), 2, 1)).toThrow(RangeError);
    const max = rgbaToPixelSVG(new Uint8Array(256 * 256 * 4), 256, 256);
    expect(max.runs).toBe(256);
    expect(max.colors).toBe(1);
    expect(max.pixels).toBe(65536);
  });
});
