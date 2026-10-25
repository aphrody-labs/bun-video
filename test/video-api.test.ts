import { expect, test } from "bun:test";
import { VIDEO_APIS, describeVideoAPIs, inspectVideoAPI, loadVideoAPI, type VideoAPIFamily } from "../src/video-api";

test("API inventory is lazy, unique and covers published families", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const inventory = describeVideoAPIs();
  expect(inventory).toBe(VIDEO_APIS);
  expect(new Set(inventory.map(api => api.id)).size).toBe(inventory.length);
  for (const path of Object.keys(manifest.exports)) {
    if ([".", "./engine", "./mpd"].includes(path)) continue;
    expect(inventory.some(api => api.module === `@aphrody/bun-video/${path.slice(2)}`)).toBe(true);
  }
});

test("registry loads the real source owner and exposes export kinds without values", async () => {
  const module = await loadVideoAPI("source");
  const { resolveVideoSource } = await import("../src/source");
  expect(module.resolveVideoSource).toBe(resolveVideoSource);
  expect(module.resolveVideoSource("clips/example.mp4")).toEqual({ kind: "file", path: "clips/example.mp4" });
  const description = await inspectVideoAPI("source");
  expect(description.qualification).toBe("module-load-only");
  expect(description.exports).toContainEqual({ name: "resolveVideoSource", kind: "function" });
  expect(description.exports.every(entry => Object.keys(entry).sort().join(",") === "kind,name")).toBe(true);
  await expect(loadVideoAPI("__proto__" as VideoAPIFamily)).rejects.toThrow("Unknown Bun Video API family");
});
