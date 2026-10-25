import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPlan, libraryWorkerPlugin, verifiedLibraryPlan } from "../scripts/library-plan";

test("published aliases share one compiled owner and refuse path/output collisions", () => {
  const plan = libraryPlan({
    name: "@aphrody/bun-video",
    version: "fixture",
    exports: {
      ".": "./src/index.ts",
      "./engine": "./src/index.ts",
      "./studio": "./src/studio.tsx",
    },
    bin: { "bun-video": "./umbrella-src/cli.ts" },
  });
  expect(plan.exports["."]).toEqual({
    types: "./dist/types/src/index.d.ts",
    bun: "./dist/src/index.ts",
    default: "./dist/src/index.ts",
  });
  expect(plan.exports["./engine"]).toEqual(plan.exports["."]);
  expect(plan.entries.filter(path => path === "./src/index.ts")).toHaveLength(1);
  expect(plan.outputs).toContain("./dist/src/studio.ts");
  expect(() =>
    libraryPlan({ name: "fixture", version: "fixture", exports: { ".": "./../private.ts" }, bin: {} }),
  ).toThrow("escapes");
  expect(() =>
    libraryPlan({
      name: "fixture",
      version: "fixture",
      exports: { ".": "./src/index.ts", "./other": "./src/index.tsx" },
      bin: {},
    }),
  ).toThrow("overwrite");
});

test("a split library starts its packaged worker from a consumer outside the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-library-plan-"));
  await mkdir(join(root, "src"));
  const source = { ".": "./src/index.ts", "./engine": "./src/index.ts", "./capture": "./src/parallel-capture.ts" };
  const initial = { name: "@aphrody/bun-video", version: "fixture", exports: source, bin: {} };
  const plan = libraryPlan(initial);
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ ...initial, exports: plan.exports, bunVideo: { sourceExports: source, sourceBins: {} } }),
  );
  await Bun.write(
    join(root, "src/index.ts"),
    'export {workerURL} from "./parallel-capture.ts";\nexport const value=42;\n',
  );
  await Bun.write(
    join(root, "src/parallel-capture.ts"),
    'export function workerURL(){return new URL("./frame-worker.ts", import.meta.url);}\n',
  );
  await Bun.write(join(root, "src/frame-worker.ts"), "postMessage({value:42});\n");
  await Bun.write(join(root, "src/video-worker-entry.ts"), 'export const entry="fixture";\n');
  const verified = await verifiedLibraryPlan(root);
  const result = await Bun.build({
    entrypoints: verified.entries.map(path => join(root, path)),
    root,
    outdir: join(root, "dist"),
    target: "bun",
    format: "esm",
    splitting: true,
    naming: { entry: "[dir]/[name].ts", chunk: "chunks/[name]-[hash].js" },
    plugins: [libraryWorkerPlugin(root)],
  });
  expect(result.success).toBe(true);
  if (!result.success) throw new AggregateError(result.logs, "Fixture library build failed");
  await Bun.write(
    join(root, "consumer.ts"),
    `import * as main from "@aphrody/bun-video";
import * as engine from "@aphrody/bun-video/engine";
const worker=new Worker(main.workerURL());
const message=await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=reject;});
worker.terminate();console.log(JSON.stringify({alias:main===engine,value:main.value,message}));\n`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", "consumer.ts"], {
    cwd: root,
    env: {
      SystemRoot: Bun.env.SystemRoot ?? "",
      PATH: Bun.env.PATH ?? "",
      TEMP: tmpdir(),
      TMP: tmpdir(),
      BUN_DEBUG_QUIET_LOGS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ alias: true, value: 42, message: { value: 42 } });
  expect(code).toBe(0);
});
