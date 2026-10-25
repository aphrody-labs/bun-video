import { describe, expect, test } from "bun:test";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { libraryPlan } from "../scripts/library-plan";
import { publicPackageFile } from "../scripts/package-file-policy";

const root = resolve(import.meta.dir, "..");
const manifest = await Bun.file(resolve(root, "package.json")).json();
const plan = libraryPlan(manifest);

describe("canonical sources and published library plan", () => {
  test("every relative source import remains inside the packaged directory", async () => {
    const typescript = new Bun.Transpiler({ loader: "ts" });
    const tsx = new Bun.Transpiler({ loader: "tsx" });
    const imports: string[] = [];
    for await (const entry of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: root })) {
      const sourcePath = resolve(root, entry);
      const transpiler = entry.endsWith(".tsx") ? tsx : typescript;
      for (const imported of transpiler.scanImports(await Bun.file(sourcePath).text())) {
        if (!imported.path.startsWith(".")) continue;
        const target = resolve(dirname(sourcePath), imported.path);
        const within = relative(root, target);
        if (within.startsWith("..") || isAbsolute(within)) imports.push(`${entry}: ${imported.path}`);
      }
    }
    expect(imports).toEqual([]);
    expect(await Bun.file(resolve(root, "src/frame-worker.ts")).exists()).toBe(true);
    expect(await Bun.file(resolve(root, "src/parallel-capture.ts")).text()).toContain('"./frame-worker.ts"');
  });

  test("published exports and CLI entries bind existing source owners to confined dist paths", async () => {
    expect(manifest.private).not.toBe(true);
    const sdk = await Bun.file(Bun.resolveSync("@aphrody/bun-runtime-sdk/package.json", root)).json();
    expect(sdk.name).toBe("@aphrody/bun-runtime-sdk");
    expect(manifest.dependencies["@aphrody/bun-runtime-sdk"]).toBe(sdk.version);
    expect(
      Object.values(manifest.dependencies).every(value => typeof value === "string" && !value.startsWith("file:")),
    ).toBe(true);
    expect(manifest.publishConfig).toEqual({ access: "public", tag: "next" });
    expect(manifest.exports).toEqual(plan.exports);
    expect(manifest.bin).toEqual(plan.bins);
    for (const entry of [...Object.values(plan.sourceExports), ...Object.values(plan.sourceBins)]) {
      expect(/^(\.\/(src|umbrella-src|remotion|hyperframes|mediabunny)\/)/.test(entry)).toBe(true);
      expect(await Bun.file(resolve(root, entry)).exists()).toBe(true);
    }
    for (const entry of Object.values(plan.sourceBins)) {
      expect((await Bun.file(resolve(root, entry)).text()).startsWith("#!/usr/bin/env bun")).toBe(true);
    }
    expect(manifest.files.length).toBeGreaterThan(1000);
    expect(manifest.files.every((entry: string) => !/[*!?]/.test(entry) && publicPackageFile(entry))).toBe(true);
    expect(manifest.files).toContain("dist");
    expect(manifest.files).toContain("tsconfig.json");
    expect(manifest.files).toContain("mediabunny/shared/mp3-misc.ts");
    expect(manifest.files).toContain("remotion/bundler/favicon.ico");
    for (const source of plan.entries) expect(manifest.files).toContain(source.slice(2));
  });

  test("direct engine exports resolve to the absorbed source", async () => {
    expect(plan.sourceExports["./remotion"]).toBe("./remotion/core/src/index.ts");
    expect(plan.sourceExports["./hyperframes"]).toBe("./hyperframes/core/src/index.ts");
    for (const entry of [plan.sourceExports["./remotion"], plan.sourceExports["./hyperframes"]]) {
      expect(await Bun.file(resolve(root, entry)).exists()).toBe(true);
    }
    expect(manifest.dependencies.remotion).toBeUndefined();
    expect(manifest.dependencies["@hyperframes/core"]).toBeUndefined();
  });

  test("source owners retain canonical implementation references before library generation", async () => {
    const main = await import("../src/index");
    const encode = await import("../src/encode");
    const computer = await import("../src/computer");
    const hyperframes = await import("../hyperframes/engine/src/services/nativeWebViewCapture");
    expect(plan.sourceExports["./engine"]).toBe(plan.sourceExports["."]);
    expect(encode.encodeVideo).toBe(main.encodeVideo);
    expect(computer.runBrowserTask).toBe(main.runBrowserTask);
    expect(hyperframes.captureNativeWebViewFrames).toBe(main.captureNativeWebViewFrames);
  });

  test("the engine CLI retains its commands after entrypoint consolidation", async () => {
    const child = Bun.spawn([process.execPath, resolve(root, plan.sourceBins["bun-video"]!), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(output).toContain("bun-video capabilities");
    expect(output).toContain("bun-video mcp");
    expect(output).toContain("bun-video encode");
    expect(errors).toBe("");
    expect(exitCode).toBe(0);
  });

  test("absorbed Remotion core loads as Bun source without generated dist files", async () => {
    const core = await import(resolve(root, plan.sourceExports["./remotion"]!));
    expect(typeof core.Composition).toBe("function");
    expect(typeof core.interpolate).toBe("function");
    expect(core.interpolate(5, [0, 10], [0, 100])).toBe(50);
    expect(typeof core.AbsoluteFill).toBe("object");
  });

  test("the package renderer and Remotion share one React dispatcher", async () => {
    const React = await import("react");
    const dom = await import("react-dom/server");
    const core = await import(resolve(root, plan.sourceExports["./remotion"]!));
    const html = dom.renderToStaticMarkup(React.createElement(core.AbsoluteFill, null, "source-render-fixture"));
    expect(html).toContain("source-render-fixture");
    expect(html).toContain("position:absolute");
    expect(React.version).toBe(manifest.dependencies.react);
  });

  test("absorbed HyperFrames core loads as Bun source", async () => {
    const core = await import(resolve(root, plan.sourceExports["./hyperframes"]!));
    expect(typeof core.generateBaseHtml).toBe("function");
    expect(typeof core.parseSlideshowManifest).toBe("function");
  });

  test("public source and browser assets contain no private fixture files", async () => {
    const invalid: string[] = [];
    for await (const entry of new Bun.Glob("{src,assets,docs}/**/*").scan({
      cwd: root,
      onlyFiles: true,
    })) {
      if (/(^|[\\/])(cookie(?:s)?\.json|hls\.json|.*\.har|\.env(?:\..*)?|cookie-reference\.json)$/i.test(entry))
        invalid.push(entry);
    }
    expect(invalid).toEqual([]);
  });
});
