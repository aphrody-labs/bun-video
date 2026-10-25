import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import { mkdir } from "node:fs/promises";

export async function measureStack(aphrodyRoot: string, bunRoot: string, nativeLibrary?: string) {
  const stages: Record<string, unknown> = {};
  const work = resolve(bunRoot, "tmp/video-benchmark/stack");
  await mkdir(work, { recursive: true });
  const load = (file: string) => import(pathToFileURL(file).href);
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const source = `import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { interpolate } from ${JSON.stringify(`${bunRoot}/packages/bun-video/remotion/packages/core/src/interpolate.ts`)};
import { generateSpringEaseData } from ${JSON.stringify(`${bunRoot}/packages/bun-video/hyperframes/packages/parsers/src/springEase.ts`)};
const root = createRoot(document.getElementById("root"));
const curve = generateSpringEaseData(1, 180, 12, 120);
globalThis.setBenchmarkFrame = frame => flushSync(() => root.render(React.createElement("main", {
  id: "scene", "data-ready": "yes", "data-frame": frame,
  style: { background: "var(--md-sys-color-primary)", width: 320, height: 180, opacity: interpolate(frame, [0, 15, 30], [0.2, 1, 0.2]) }
}, "React + Remotion + HyperFrames", React.createElement("svg", { viewBox: "0 0 1 1", width: 120, height: 80 }, React.createElement("path", { d: curve, fill: "none", stroke: "white", strokeWidth: 0.02 })))));
globalThis.setBenchmarkFrame(0);`;
    let script = source;
    let start = performance.now();
    try {
      const { NativeTooling } = await load(`${bunRoot}/packages/bun-runtime-sdk/src/tooling.ts`);
      const tooling = new NativeTooling(nativeLibrary ? { path: nativeLibrary } : {});
      try {
        script = tooling.minifySource(source, "scene.js");
      } finally {
        tooling.close();
      }
      if (!script) throw new Error("Oxc returned empty output");
      stages.oxc = { status: "passed", ms: performance.now() - start, bytes: script.length };
    } catch (error) {
      stages.oxc = { status: "blocked", reason: String(error) };
    }
    await Bun.write(`${work}/scene.js`, script);
    await Bun.write(
      `${work}/index.html`,
      '<!doctype html><html><head><link rel="stylesheet" href="m3:theme.css"></head><body><div id="root"></div><script type="module" src="./scene.js"></script></body></html>',
    );
    start = performance.now();
    try {
      const { buildM3 } = await load(`${aphrodyRoot}/m3/packages/m3/src/build.ts`);
      const build = await buildM3({
        entry: `${work}/index.html`,
        cwd: work,
        outdir: `${work}/dist`,
        plugin: { root: aphrodyRoot, theme: { seed: "#137c66" } },
      });
      if (!build.outputs.length) throw new Error("M3 emitted no assets");
      stages.m3 = { status: "passed", ms: performance.now() - start, outputs: build.outputs };
    } catch (error) {
      stages.m3 = { status: "blocked", reason: String(error) };
    }
    const { BrowserRuntime } = await load(`${bunRoot}/packages/bun-runtime-sdk/src/browser.ts`);
    browser = BrowserRuntime.load(nativeLibrary ? { libraryPath: nativeLibrary } : {});
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const pathname = decodeURIComponent(new URL(req.url).pathname);
        const path = resolve(work, "dist", `.${pathname === "/" ? "/index.html" : pathname}`);
        if (relative(`${work}/dist`, path).startsWith("..")) return new Response(null, { status: 403 });
        const file = Bun.file(path);
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      },
    });
    const origin = server.url.origin;
    using context = browser.createContext({
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      width: 320,
      height: 180,
      timeoutMs: 10000,
    });
    start = performance.now();
    await context.navigate(origin);
    const ready = await context.evaluate('document.getElementById("scene").dataset.ready');
    if (ready !== "yes") throw new Error("Obscura did not execute the Oxc-generated script");
    const frames = [];
    for (const frame of [0, 15, 30]) {
      await context.evaluate(`globalThis.setBenchmarkFrame(${frame})`);
      const actual = await context.evaluate('Number(document.getElementById("scene").dataset.frame)');
      if (actual !== frame) throw new Error(`React frame seek mismatch: ${actual} != ${frame}`);
      const png: Uint8Array = await context.screenshot();
      if (Buffer.from(png.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a")
        throw new Error("Obscura capture is not PNG");
      frames.push({
        frame,
        pngBytes: png.length,
        sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
      });
      await Bun.write(`${work}/frame-${frame}.png`, png);
    }
    stages.obscura = { status: "passed", ms: performance.now() - start, frames };
    const passed = Object.values(stages).every(stage => (stage as { status: string }).status === "passed");
    return {
      status: passed ? "passed" : "blocked",
      scope:
        "Integration probe of custom native M3 theme + Oxc JS + Obscura navigation/evaluation/PNG, not a video throughput comparison",
      stages,
    };
  } catch (error) {
    stages.obscura = { status: "blocked", reason: String(error) };
    return { status: "blocked", stages };
  } finally {
    server?.stop(true);
    browser?.close();
  }
}
