import { expect, test } from "bun:test";
import { frameThemeFromRGBA, seedFromRGBA } from "../src/frame-theme";

const rgba = (red: number, green: number, blue: number, count = 16) =>
  new Uint8Array(Array.from({ length: count }, () => [red, green, blue, 255]).flat());

test("video frame themes derive different M3 roles from actual red and blue frames", () => {
  const red = frameThemeFromRGBA(rgba(230, 40, 35), 4, 4, { dark: true, variant: "content" });
  const blue = frameThemeFromRGBA(rgba(35, 60, 230), 4, 4, { dark: true, variant: "content" });
  expect(red.seed).toBe("#e62823");
  expect(blue.seed).toBe("#233ce6");
  expect(red.roles["--md-sys-color-primary"]).not.toBe(blue.roles["--md-sys-color-primary"]);
  expect(red.roles["--md-sys-color-surface"]).not.toBe(blue.roles["--md-sys-color-surface"]);
  expect(Object.keys(red.roles).length).toBeGreaterThan(40);
  expect(Object.keys(red.roles).every(key => key.startsWith("--md-sys-color-"))).toBe(true);
});

test("letterbox black and transparent overlays do not dominate coloured content", () => {
  const pixels = new Uint8Array([...rgba(0, 0, 0, 12), ...rgba(208, 165, 45, 4)]);
  expect(seedFromRGBA(pixels, 4, 4)).toBe("#d0a52d");
  const alpha = rgba(240, 0, 0, 12);
  for (let i = 3; i < alpha.length; i += 4) alpha[i] = 0;
  expect(seedFromRGBA(new Uint8Array([...alpha, ...rgba(45, 125, 80, 4)]), 4, 4)).toBe("#2d7d50");
  expect(seedFromRGBA(rgba(0, 0, 0), 4, 4)).toBe("#000000");
});

test("frame theme sampling rejects oversized, malformed and fully transparent frames", () => {
  expect(() => seedFromRGBA(new Uint8Array(), 1, 1)).toThrow();
  expect(() => seedFromRGBA(new Uint8Array(4), 100000, 100000)).toThrow();
  expect(() => seedFromRGBA(new Uint8Array(4), 1, 1)).toThrow("visible pixels");
  expect(() => frameThemeFromRGBA(rgba(25, 125, 80), 4, 4, { contrastLevel: 2 })).toThrow();
});
