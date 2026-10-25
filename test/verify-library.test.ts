import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPlan } from "../scripts/library-plan";
import { assertLibraryOutputDirectory, ownedLibraryOutputs, verifyLibrary } from "../scripts/verify-library";

const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("an output junction cannot redirect verification or refresh to another owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-library-junction-"));
  const other = await mkdtemp(join(tmpdir(), "bun-video-other-output-"));
  await Bun.write(join(other, "sentinel.txt"), "synthetic other owner\n");
  await symlink(other, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  await expect(assertLibraryOutputDirectory(root, true)).rejects.toThrow("output directory redirects");
  await expect(verifyLibrary(root)).rejects.toThrow("output directory redirects");
  await expect(ownedLibraryOutputs(root)).rejects.toThrow("output directory redirects");
  expect(await Bun.file(join(other, "sentinel.txt")).text()).toBe("synthetic other owner\n");
});

test("packaging rejects changed source, changed output and an unreceipted stale chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-library-receipt-"));
  await mkdir(join(root, "src"));
  const initial = { name: "@aphrody/bun-video", version: "fixture", exports: { ".": "./src/index.ts" }, bin: {} };
  const plan = libraryPlan(initial);
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ ...initial, exports: plan.exports, bunVideo: { sourceExports: initial.exports, sourceBins: {} } }),
  );
  await Bun.write(join(root, "src/index.ts"), "export const value=42;\n");
  await Bun.write(join(root, "src/frame-worker.ts"), "export const frame=1;\n");
  await Bun.write(join(root, "src/video-worker-entry.ts"), "export const worker=1;\n");
  const built = await Bun.build({
    entrypoints: plan.entries.map(path => join(root, path)),
    root,
    outdir: join(root, "dist"),
    target: "bun",
    naming: "[dir]/[name].ts",
  });
  expect(built.success).toBe(true);
  const declarationPath = join(root, "dist/types/src/index.d.ts");
  await Bun.write(declarationPath, "export declare const value = 42;\n");
  const outputs = await Promise.all(
    built.outputs.map(async file => ({
      name: file.path.slice(join(root, "dist").length + 1).replaceAll("\\", "/"),
      bytes: (await Bun.file(file.path).bytes()).length,
      sha256: hash(await Bun.file(file.path).bytes()),
    })),
  );
  const declarationBytes = await Bun.file(declarationPath).bytes();
  outputs.push({ name: "types/src/index.d.ts", bytes: declarationBytes.length, sha256: hash(declarationBytes) });
  const source = await Bun.file(join(root, "src/index.ts")).bytes();
  await Bun.write(
    join(root, "dist/library-receipt.json"),
    JSON.stringify({
      schemaVersion: 1,
      package: initial.name,
      version: initial.version,
      manifestSha256: hash(await Bun.file(join(root, "package.json")).bytes()),
      outputs,
      inputs: [{ name: "src/index.ts", bytes: source.length, sha256: hash(source) }],
    }),
  );
  expect((await verifyLibrary(root)).files).toBe(4);
  await Bun.write(join(root, "src/index.ts"), "export const value=43;\n");
  await expect(verifyLibrary(root)).rejects.toThrow("input changed");
  expect((await ownedLibraryOutputs(root)).size).toBe(4);
  await Bun.write(join(root, "src/index.ts"), source);
  const output = await Bun.file(join(root, "dist/src/index.ts")).bytes();
  await Bun.write(join(root, "dist/src/index.ts"), "export const value=0;\n");
  await expect(verifyLibrary(root)).rejects.toThrow("output changed");
  await expect(ownedLibraryOutputs(root)).rejects.toThrow("refresh refused");
  await Bun.write(join(root, "dist/src/index.ts"), output);
  await Bun.write(join(root, "dist/stale.js"), "export const stale=1;\n");
  await expect(verifyLibrary(root)).rejects.toThrow("Unowned or stale");
  await expect(ownedLibraryOutputs(root)).rejects.toThrow("Unowned file prevents");
});
