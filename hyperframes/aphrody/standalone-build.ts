import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import packageTsconfig from "../../tsconfig.json";
import { resolveNativeCompositionTarget, sharpNativePlugin } from "./sharp-native-plugin";
import { hyperframesRuntimeAssetsPlugin } from "./runtime-assets-plugin";
import { remotionSourcePlugin } from "../../remotion/.aphrody/standalone-build";
import { moduleManifest } from "../../scripts/modules";

export const hyperframesRoot = resolve(import.meta.dir, "..");
export const hyperframesCliEntry = join(hyperframesRoot, "cli/src/cli.ts");
type StandaloneTarget = NonNullable<import("bun").CompileBuildOptions["target"]>;

export async function prepareHyperframesStandalone(): Promise<void> {
  const generators = [
    "build-svg-selector-aliases.ts",
    "build-hyperframes-runtime-artifact.ts",
    "build-position-edits-render.ts",
    "build-audio-fx-runtime.ts",
  ];
  for (const script of generators) {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", join("scripts", script)], {
      cwd: join(hyperframesRoot, "core"),
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await process.exited;
    if (code !== 0) throw new Error(`Hyperframes core ${script} failed with exit ${code}`);
  }
}

/**
 * The absorbed HyperFrames tree has no own alias table for the generated core modules and no installed
 * dependencies. Resolve those from the owned bun-video tsconfig aliases, then from the pinned build registry.
 */
export function hyperframesDependencyPlugin(): BunPlugin {
  const aliases: Record<string, string[]> = packageTsconfig.compilerOptions.paths;
  const registry = resolve(hyperframesRoot, "../remotion/.aphrody/build-deps");
  return {
    name: "hyperframes-dependency-resolution",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
        if (!importer.startsWith(hyperframesRoot)) return;
        if (path.startsWith("node:") || path.startsWith("bun:") || path === "bun") return;
        const alias = aliases[path];
        if (alias?.length === 1 && path.startsWith("@hyperframes/")) {
          const target = resolve(hyperframesRoot, "..", alias[0]!);
          if (existsSync(target)) return { path: target };
        }
        try {
          Bun.resolveSync(path, importer);
          return;
        } catch {}
        try {
          return { path: Bun.resolveSync(path, registry) };
        } catch {
          return;
        }
      });
    },
  };
}

export async function hyperframesStandaloneConfig(options: {
  outfile: string;
  target?: StandaloneTarget;
  entrypoint?: string;
}): Promise<Bun.BuildConfig> {
  const manifest = await moduleManifest(hyperframesRoot, "cli");
  if (!manifest) throw new Error("The absorbed Hyperframes CLI manifest is absent");
  await mkdir(dirname(resolve(options.outfile)), { recursive: true });
  return {
    entrypoints: [options.entrypoint ?? hyperframesCliEntry],
    target: "bun",
    compile: {
      ...(options.target ? { target: options.target } : {}),
      outfile: resolve(options.outfile),
      executablePath: process.execPath,
    },
    define: {
      __CLI_VERSION__: JSON.stringify(manifest.version),
      __PRODUCER_VERSION__: JSON.stringify(manifest.version),
      __HYPERFRAMES_ENGINE_VERSION__: JSON.stringify(manifest.version),
      __HYPERFRAMES_STANDALONE__: "true",
    },
    minify: true,
    sourcemap: "none",
    // Literal dynamic imports retain every upstream command in the compiled graph.
    external: [],
  };
}

export async function buildHyperframesStandalone(options: {
  outfile: string;
  target?: StandaloneTarget;
  entrypoint?: string;
}): Promise<void> {
  const target = resolveNativeCompositionTarget();
  if (
    options.target &&
    options.target.replace(/-(?:baseline|modern)$/, "") !== target.compileTarget
  ) {
    throw new Error("Standalone composition assets must match the native compiler host ABI");
  }
  await prepareHyperframesStandalone();
  const bootstrap = join(dirname(resolve(options.outfile)), "hyperframes-standalone-entry.ts");
  await Bun.write(
    bootstrap,
    `import {join} from "node:path";
if(!process.env.HYPERFRAMES_FFMPEG_PATH || !process.env.HYPERFRAMES_FFPROBE_PATH){
  const {dir}=await import(${JSON.stringify(target.compositorPackage)});
  process.env.HYPERFRAMES_FFMPEG_PATH ??=join(dir,${JSON.stringify("ffmpeg" + target.executableSuffix)});
  process.env.HYPERFRAMES_FFPROBE_PATH ??=join(dir,${JSON.stringify("ffprobe" + target.executableSuffix)});
}
await import(${JSON.stringify(options.entrypoint ?? hyperframesCliEntry)});
`,
  );
  const config = await hyperframesStandaloneConfig({ ...options, entrypoint: bootstrap });
  const result = await Bun.build({
    ...config,
    plugins: [
      await remotionSourcePlugin(),
      await sharpNativePlugin(),
      hyperframesRuntimeAssetsPlugin(),
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Complete Hyperframes CLI compilation failed");
  if (!(await Bun.file(resolve(options.outfile)).exists()))
    throw new Error("Compiler did not write the requested executable");
  console.log(
    JSON.stringify({
      outfile: resolve(options.outfile),
      runtime: Bun.version,
      entrypoint: options.entrypoint ?? hyperframesCliEntry,
    }),
  );
}

if (import.meta.main) {
  const outfile = Bun.argv[2];
  if (!outfile) throw new Error("Usage: bun aphrody/standalone-build.ts <absolute-outfile>");
  await buildHyperframesStandalone({ outfile });
}
