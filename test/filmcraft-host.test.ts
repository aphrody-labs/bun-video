import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("FilmCraft Bun host serves WASM and rejects paths and writes outside its artifact contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "filmcraft-host-"));
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Aphrody Video</title>");
  await Bun.write(join(root, "editor.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/apps/filmcraft/server.ts")], {
    env: { ...Bun.env, FILMCRAFT_DIST: root, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error("host startup deadline")), 5000);
      }),
    ]);
    clearTimeout(startupTimer);
    const { port } = JSON.parse(new TextDecoder().decode(first.value));
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/film/`);
    expect(await page.text()).toContain("Aphrody Video");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const wasm = await fetch(`${base}/film/editor.wasm?v=fixture`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect((await fetch(`${base}/film/index.html`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/film/%2e%2e%2fsecret.json`)).status).toBe(404);
    expect((await fetch(`${base}/film/%00index.html`)).status).toBe(404);
    const head = await fetch(`${base}/film/editor.wasm`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("8");
    expect(await head.text()).toBe("");
  } finally {
    clearTimeout(startupTimer);
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
