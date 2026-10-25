import { join, resolve } from "node:path";

export function hyperframesRuntimeAssetsPlugin(): Bun.BunPlugin {
  const root = resolve(import.meta.dir, "..");
  const manifest = join(root, "core/dist/hyperframe.manifest.json");
  const runtime = join(root, "core/dist/hyperframe.runtime.iife.js");
  return {
    name: "hyperframes-verified-runtime-assets",
    setup(build) {
      build.onLoad({ filter: /[\\/]producer[\\/]src[\\/]services[\\/]hyperframeRuntimeLoader\.ts$/ }, async ({ path }) => {
        let source = await Bun.file(path).text();
        const manifestLookup = "const envOverride = process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH;";
        const runtimeLookup = "const runtimePath = resolve(dirname(manifestPath), runtimeFileName);";
        if (!source.includes(manifestLookup) || !source.includes(runtimeLookup)) {
          throw new Error("Hyperframes runtime asset loader changed; review embedded manifest/runtime resolution");
        }
        source = source.replace(manifestLookup, "const envOverride = process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH ?? embeddedManifest;")
          .replace(runtimeLookup, "const runtimePath = process.env.PRODUCER_HYPERFRAME_MANIFEST_PATH ? resolve(dirname(manifestPath), runtimeFileName) : embeddedRuntime;");
        return {
          loader: "ts",
          contents: `import embeddedManifest from ${JSON.stringify(manifest)} with {type:"file"};\nimport embeddedRuntime from ${JSON.stringify(runtime)} with {type:"file"};\n${source}`,
        };
      });
    },
  };
}
