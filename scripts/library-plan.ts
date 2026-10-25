import { isAbsolute, join, relative, resolve } from "node:path";

export interface LibraryManifest {
  name: string;
  version: string;
  exports: Record<string, string | { types: string; bun: string; default: string }>;
  bin: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  bunVideo?: {
    sourceExports: Record<string, string>;
    sourceBins: Record<string, string>;
    qualificationPeers?: Record<string, string>;
  };
}

function sourcePath(value: string): string {
  if (
    !value.startsWith("./") ||
    value.includes("\\") ||
    value
      .split("/")
      .slice(1)
      .some(part => !part || part === ".." || part === ".")
  )
    throw new Error(`Library source escapes its package: ${value}`);
  if (!/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(value)) throw new Error(`Unsupported library entry: ${value}`);
  return value;
}

export function libraryPlan(manifest: LibraryManifest) {
  const sourceExports =
    manifest.bunVideo?.sourceExports ??
    Object.fromEntries(
      Object.entries(manifest.exports).map(([name, entry]) => [name, typeof entry === "string" ? entry : entry.types]),
    );
  const sourceBins = manifest.bunVideo?.sourceBins ?? manifest.bin;
  const outputFor = (source: string) =>
    "./dist/" +
    sourcePath(source)
      .slice(2)
      .replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, ".ts");
  const typesFor = (source: string) =>
    "./dist/types/" +
    sourcePath(source)
      .slice(2)
      .replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, ".d.ts");
  const workers = ["./src/frame-worker.ts", "./src/video-worker-entry.ts"];
  const entries = [
    ...new Set([...Object.values(sourceExports), ...Object.values(sourceBins), ...workers].map(sourcePath)),
  ].sort();
  const outputs = entries.map(outputFor);
  if (new Set(outputs).size !== entries.length) throw new Error("Two library sources would overwrite the same output");
  const exports = Object.fromEntries(
    Object.entries(sourceExports).map(([name, source]) => [
      name,
      {
        types: typesFor(source),
        bun: outputFor(source),
        default: outputFor(source),
      },
    ]),
  );
  const bins = Object.fromEntries(Object.entries(sourceBins).map(([name, source]) => [name, outputFor(source)]));
  return {
    entries,
    outputs,
    exports,
    bins,
    sourceExports,
    sourceBins,
    workers,
    typeOutputs: [...new Set(Object.values(sourceExports).map(typesFor))],
  };
}

export async function verifiedLibraryPlan(root: string) {
  const manifest = (await Bun.file(join(root, "package.json")).json()) as LibraryManifest;
  const plan = libraryPlan(manifest);
  for (const source of plan.entries) {
    const path = resolve(root, source);
    const name = relative(root, path);
    if (name.startsWith("..") || isAbsolute(name) || !(await Bun.file(path).exists()))
      throw new Error(`Library source is absent: ${source}`);
  }
  return { ...plan, manifest };
}

/** Workers use the published main entry as their anchor even when callers move into shared chunks. */
export function libraryWorkerPlugin(root: string): Bun.BunPlugin {
  const workers = new Map([
    [resolve(root, "src/parallel-capture.ts"), "./frame-worker.ts"],
    [resolve(root, "src/video-workers.ts"), "./video-worker-entry.ts"],
  ]);
  return {
    name: "bun-video-published-worker-locations",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/](?:parallel-capture|video-workers)\.ts$/ }, async ({ path }) => {
        const worker = workers.get(resolve(path));
        if (!worker) return;
        const contents = await Bun.file(path).text();
        const original = `new URL(${JSON.stringify(worker)}, import.meta.url)`;
        if (!contents.includes(original))
          throw new Error("The canonical worker location changed; review library packaging");
        return {
          loader: "ts",
          contents: contents.replace(
            original,
            `new URL(${JSON.stringify(worker)}, import.meta.resolve("@aphrody/bun-video"))`,
          ),
        };
      });
    },
  };
}

/** React hooks share the consumer's dispatcher across both composition integrations. */
export function libraryReactPlugin(): Bun.BunPlugin {
  return {
    name: "bun-video-consumer-react-dispatcher",
    setup(build) {
      build.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path }) => ({ path, external: true }));
    },
  };
}
