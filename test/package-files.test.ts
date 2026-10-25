import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicPackageFile } from "../scripts/package-file-policy";
import { planRemotionLibraryAssets } from "../remotion/.aphrody/module-assets-scope";

test("native pack honors literal public files and leaves unlisted test/old/private fixtures outside its tar", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-positive-pack-"));
  await mkdir(join(root, "src/test/old-version-bundle"), { recursive: true });
  await mkdir(join(root, "out"));
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ name: "bun-video-public-file-fixture", version: "1.0.0", files: ["src/index.ts"] }),
  );
  await Bun.write(join(root, "src/index.ts"), "export const value=42;\n");
  await Bun.write(join(root, "src/test/old-version-bundle/bundle.js"), "export const old=1;\n");
  await Bun.write(join(root, "src/cookie-reference.json"), "{}\n");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "pm",
      "pack",
      "--ignore-scripts",
      "--destination",
      join(root, "out"),
      "--quiet",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10000 },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain(".tgz");
  const files = await new Bun.Archive(
    await Bun.file(join(root, "out/bun-video-public-file-fixture-1.0.0.tgz")).bytes(),
  ).files();
  expect([...files.keys()].sort()).toEqual(["package/package.json", "package/src/index.ts"]);
  expect(publicPackageFile("packages/example/src/test/integration/old-version-bundle/bundle.js")).toBe(false);
  expect(publicPackageFile("packages/example/src/worker.ts")).toBe(true);
  expect(publicPackageFile("scripts/.env-private/nested.json")).toBe(false);
}, 180_000);

test("real manifest closure preserves exact owner pins and excludes optional model peers and unrelated workspaces", async () => {
  const root = join(import.meta.dir, "../remotion");
  const plan = await planRemotionLibraryAssets(root, ["@remotion/cli", "@remotion/renderer", "remotion"]);
  expect(plan.files.length).toBeGreaterThan(100);
  expect(plan.bytes).toBeLessThan(160 * 1024 * 1024);
  for (const [name, version] of [
    ["esbuild", "0.28.1"],
    ["@babel/parser", "7.24.1"],
    ["open", "8.4.2"],
  ])
    expect(plan.owners.find(owner => owner.name === name)?.manifest.version).toBe(version);
  expect(
    plan.owners.some(
      owner =>
        owner.name === "@remotion/whisper-webgpu" ||
        owner.name === "onnxruntime-node" ||
        owner.name === "@remotion/brand",
    ),
  ).toBe(false);
  expect(
    plan.skipped.some(item => item.name === "@remotion/whisper-webgpu" && item.reason === "optional-peer-not-selected"),
  ).toBe(true);
  expect(
    plan.files.every(
      file => !/(^|\/)(?:test|fixtures|__tests__|node_modules\/onnxruntime-node)(\/|$)/.test(file.destination),
    ),
  ).toBe(true);
  await expect(planRemotionLibraryAssets(root, ["../protected"])).rejects.toThrow("Unsafe physical package name");
  await expect(planRemotionLibraryAssets(root, [".."])).rejects.toThrow("Unsafe physical package name");
}, 180_000);
