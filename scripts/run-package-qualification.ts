import { availableParallelism } from "node:os";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { runQualificationProcess } from "./qualification-process";

const root = resolve(import.meta.dir, "..");
const enginesOnly = Bun.argv.includes("--engines-only");
const declarationsOnly = Bun.argv.includes("--declarations-only");
const packOnly = Bun.argv.includes("--pack-only");
const buildOnly = Bun.argv.includes("--build-only");
if ([enginesOnly, declarationsOnly, packOnly, buildOnly].filter(Boolean).length > 1)
  throw new Error("Select one diagnostic or archive qualification scope");
const typesArgument = Bun.argv.indexOf("--types-version");
const typesVersion = typesArgument >= 0 ? Bun.argv[typesArgument + 1] : Bun.env.BUN_VIDEO_TYPES_VERSION;
if (typesArgument >= 0 && (!typesVersion || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(typesVersion)))
  throw new Error("Package qualification requires an explicit published types version");
const directory = resolve(root, "../../build/media/video-package-qualification");
await mkdir(directory, { recursive: true });
if (
  !(process.platform === "win32" && process.arch === "x64") &&
  !(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))
)
  throw new Error("Package qualification requires a Windows x64 or Linux x64/arm64 native asset host");
if (process.platform === "linux" && (!Bun.env.TMPDIR || !isAbsolute(Bun.env.TMPDIR)))
  throw new Error("Linux qualification requires an explicit absolute TMPDIR on the build filesystem");
const env: Record<string, string> = {
  SystemRoot: Bun.env.SystemRoot ?? "",
  PATH: dirname(process.execPath) + delimiter + (Bun.env.PATH ?? ""),
  TEMP: Bun.env.TEMP ?? "",
  TMP: Bun.env.TMP ?? "",
  ...(Bun.env.TMPDIR ? { TMPDIR: Bun.env.TMPDIR } : {}),
  APHRODY_HOME: resolve(root, "../../build/media/neon-fixture-home"),
  BUN_VIDEO_CATALOG_BACKEND: "sqlite",
  BUN_VIDEO_DECLARATION_TRACE: "1",
  BUN_DEBUG_QUIET_LOGS: "1",
  ...(typesVersion ? { BUN_VIDEO_TYPES_VERSION: typesVersion } : {}),
};
for (const name of [
  "BUN_FACTORY_JOBS",
  "CARGO_BUILD_JOBS",
  "CMAKE_BUILD_PARALLEL_LEVEL",
  "BUN_MEDIA_JOBS",
  "BUN_VIDEO_NATIVE_EXECUTABLE",
  "BUN_VIDEO_FFMPEG",
  "BUN_VIDEO_FFPROBE",
])
  if (Bun.env[name]) env[name] = Bun.env[name]!;
const types = await Bun.file(resolve(root, "../bun-types/package.json")).json();
const phases = (
  enginesOnly
    ? [{ name: "engine-diagnostic", cwd: root, args: ["scripts/check-engines.ts", "--trace"], deadline: 50_000 }]
    : declarationsOnly
      ? [{ name: "declarations-diagnostic", cwd: root, args: ["scripts/library-declarations.ts"], deadline: 120_000 }]
      : [
          {
            name: "source-types",
            cwd: root,
            args: ["scripts/check-types.ts"],
            deadline: 60_000,
          },
          { name: "source-engines", cwd: root, args: ["scripts/check-engines.ts", "--trace"], deadline: 50_000 },
          { name: "source-lint", cwd: root, args: ["lint", "src", "test"], deadline: 15_000 },
          { name: "source-format", cwd: root, args: ["scripts/check-format.ts"], deadline: 30_000 },
          ...(!env.BUN_VIDEO_TYPES_VERSION
            ? [
                {
                  name: "types-archive",
                  cwd: resolve(root, "../bun-types"),
                  args: ["pm", "pack", "--ignore-scripts", "--destination", directory, "--quiet"],
                  deadline: 30_000,
                },
              ]
            : []),
          {
            name: "library-build",
            cwd: root,
            args: ["scripts/build.ts", "--library", ...(Bun.argv.includes("--refresh") ? ["--refresh"] : [])],
            deadline: 120_000,
          },
          { name: "archive-consumer", cwd: root, args: ["scripts/pack.ts"], deadline: 225_000 },
        ]
).filter(phase => (!packOnly || phase.name === "archive-consumer") && (!buildOnly || phase.name === "library-build"));
const started = Date.now();
const results: Array<{
  name: string;
  code: number | null;
  passed: boolean;
  elapsedMs: number;
  expired: boolean;
  signal: string | number | null;
}> = [];
const cpuRate = process.platform === "win32" ? Math.min(100, 200 / availableParallelism()) : null;
let passed = false;
try {
  for (const phase of phases) {
    console.log(JSON.stringify({ phase: phase.name, state: "starting" }));
    await Bun.write(join(directory, `${phase.name}.stdout.log`), "");
    await Bun.write(join(directory, `${phase.name}.stderr.log`), "");
    const phaseStart = Date.now();
    const remaining = Math.min(phase.deadline, 420_000 - (Date.now() - started));
    let output;
    try {
      output = await runQualificationProcess(phase.args, {
        cwd: phase.cwd,
        env,
        timeoutMs: Math.max(1, remaining),
      });
    } catch (error) {
      results.push({
        name: phase.name,
        code: null,
        passed: false,
        elapsedMs: Date.now() - phaseStart,
        expired: error instanceof Error && error.name === "TimeoutError",
        signal: null,
      });
      throw error;
    }
    await Bun.write(join(directory, `${phase.name}.stdout.log`), output.stdout);
    await Bun.write(join(directory, `${phase.name}.stderr.log`), output.stderr);
    const success = output.code === 0 && !output.signal;
    results.push({
      name: phase.name,
      code: output.code,
      passed: success,
      elapsedMs: Date.now() - phaseStart,
      expired: false,
      signal: output.signal,
    });
    console.log(JSON.stringify(results.at(-1)));
    if (!success) throw new Error(`Package qualification failed at ${phase.name}`);
  }
  passed = true;
} finally {
  await Bun.write(
    join(
      directory,
      enginesOnly
        ? "engine-diagnostic-qualification.json"
        : declarationsOnly
          ? "declarations-diagnostic-qualification.json"
          : buildOnly
            ? "library-build-qualification.json"
            : "package-sequence-qualification.json",
    ),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed,
        runtime: Bun.version,
        revision: Bun.revision,
        platform: process.platform,
        arch: process.arch,
        cpuRate,
        elapsedMs: Date.now() - started,
        scope: enginesOnly
          ? "engine-diagnostic"
          : declarationsOnly
            ? "declarations-diagnostic"
            : packOnly
              ? "archive-consumer"
              : buildOnly
                ? "library-build"
                : "complete",
        ...(enginesOnly || declarationsOnly || buildOnly
          ? {}
          : {
              typesSource: env.BUN_VIDEO_TYPES_VERSION ? "registry" : "archive",
              typesVersion: env.BUN_VIDEO_TYPES_VERSION ?? types.version,
            }),
        phases: results,
      },
      null,
      2,
    ) + "\n",
  );
}
