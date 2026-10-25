import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts", target: "bun", tsconfig: { compilerOptions: { jsx: "react" } } }),
  tsx: new Bun.Transpiler({ loader: "tsx", target: "bun", tsconfig: { compilerOptions: { jsx: "react" } } }),
};
let checked = 0;
let failed = 0;
const trace = Bun.argv.includes("--trace");
const started = performance.now();
let readMs = 0;
let transformMs = 0;
if (trace)
  console.error(JSON.stringify({ event: "engine-start", runtime: Bun.revision, executable: process.execPath }));
for await (const entry of new Bun.Glob("{remotion,hyperframes}/*/src/**/*.{ts,tsx}").scan({
  cwd: root,
  onlyFiles: true,
})) {
  if (entry.endsWith(".d.ts")) continue;
  checked++;
  try {
    const reading = performance.now();
    const source = await Bun.file(resolve(root, entry)).text();
    const transforming = performance.now();
    readMs += transforming - reading;
    transpilers[entry.endsWith(".tsx") ? "tsx" : "ts"].transformSync(source);
    transformMs += performance.now() - transforming;
  } catch (error) {
    failed++;
    const issues = error instanceof AggregateError ? error.errors : [error];
    for (const issue of issues) {
      console.error(
        JSON.stringify({
          file: entry,
          message: issue?.message ?? String(issue),
          line: issue?.position?.line,
          column: issue?.position?.column,
        }),
      );
    }
  }
  if (trace && checked % 1024 === 0)
    console.error(
      JSON.stringify({
        event: "engine-progress",
        checked,
        failed,
        elapsedMs: Math.round(performance.now() - started),
        readMs: Math.round(readMs),
        transformMs: Math.round(transformMs),
        rssBytes: process.memoryUsage.rss(),
        lastFile: entry,
      }),
    );
}
console.log(
  JSON.stringify({
    checked,
    failed,
    ...(trace
      ? {
          elapsedMs: Math.round(performance.now() - started),
          readMs: Math.round(readMs),
          transformMs: Math.round(transformMs),
        }
      : {}),
  }),
);
if (failed) process.exitCode = 1;
