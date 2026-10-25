import { expect, test } from "bun:test";
import { inspectPackageArchive, runtimeBuiltinModule } from "../scripts/qualify-package";

async function fixture(extra: Record<string, string> = {}, changes: Record<string, unknown> = {}) {
  return await new Bun.Archive(
    {
      "package/package.json": JSON.stringify({
        name: "@aphrody/bun-video",
        version: "1.4.4-video.2",
        exports: { ".": "./src/index.ts" },
        bin: { "bun-video": "./src/cli.ts" },
        ...changes,
      }),
      "package/src/index.ts": 'export {value} from "./worker.js";\n',
      "package/src/worker.ts": "export const value = 42;\n",
      "package/src/cli.ts": "#!/usr/bin/env bun\nconsole.log('fixture');\n",
      ...extra,
    },
    { compress: "gzip" },
  ).bytes();
}

test("fork hardcoded modules are actual runtime owners, while optional proxy and missing modules stay explicit", async () => {
  for (const name of ["dotenv", "node-fetch", "abort-controller", "picocolors"]) {
    expect(runtimeBuiltinModule(name)).toBe(true);
    expect(Object.keys(await import(name)).length).toBeGreaterThan(0);
  }
  expect(runtimeBuiltinModule("missing-production-dependency")).toBe(false);
  const bytes = await fixture({
    "package/src/index.ts": 'import "dotenv"; import "node-fetch"; export const value=42;\n',
  });
  expect((await inspectPackageArchive(bytes)).exports).toEqual(["."]);
});

test("archive gate binds entrypoints and the actual JS-to-TS relative dependency to archive bytes", async () => {
  const bytes = await fixture();
  const result = await inspectPackageArchive(bytes);
  expect(result.exports).toEqual(["."]);
  expect(result.bins).toEqual(["bun-video"]);
  expect(result.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  expect(result.entries).toBe(4);
  const missing = await fixture({ "package/src/index.ts": 'export {worker} from "./missing";\n' });
  await expect(inspectPackageArchive(missing)).rejects.toThrow("source import leaves its payload");
});

test("archive refuses a missing entrypoint, protected payload and external runtime mapping", async () => {
  await expect(inspectPackageArchive(await fixture({}, { exports: { ".": "./outside.ts" } }))).rejects.toThrow(
    "entrypoint",
  );
  await expect(inspectPackageArchive(await fixture({ "package/.env": "synthetic=fixture\n" }))).rejects.toThrow(
    "Unsafe package entry",
  );
  await expect(
    inspectPackageArchive(
      await fixture({
        "package/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { shared: ["../../outside.ts"] } } }),
      }),
    ),
  ).rejects.toThrow("runtime mapping escapes");
});

test("only the actual public closure is required; real MTS imports and undeclared dependencies remain checked", async () => {
  const bytes = await fixture({
    "package/src/index.ts": 'export {value} from "./worker.mjs";\n',
    "package/src/worker.mts": "export const value = 42;\n",
    "package/packages/brand/src/unused.ts": 'export {unused} from "../../excluded-promotion";\n',
  });
  expect((await inspectPackageArchive(bytes)).runtimeFiles).toBe(3);
  await expect(
    inspectPackageArchive(
      await fixture({
        "package/src/index.ts": 'export {value} from "missing-production-dependency";\n',
      }),
    ),
  ).rejects.toThrow("undeclared missing-production-dependency");
});
