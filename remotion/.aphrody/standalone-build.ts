import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { remotionModuleAssetsPlugin } from "./module-assets";
import { familyModules, moduleManifest } from "../../scripts/modules";
import { resolveNativeCompositionTarget } from "../../hyperframes/aphrody/sharp-native-plugin";

export const remotionRoot = resolve(import.meta.dir, "..");

/** Resolve public workspace export entrypoints to the vendored source, including subpaths. */
export async function remotionSourcePlugin(): Promise<BunPlugin> {
  const renderer = await moduleManifest(remotionRoot, "renderer");
  if (!renderer) throw new Error("The absorbed Remotion renderer manifest is absent");
  const target = resolveNativeCompositionTarget();
  const compositorName = target.compositorPackage;
  let compositorRoot = process.env.BUN_VIDEO_COMPOSITOR_DIR ?? null;
  if (compositorName && !compositorRoot) {
    try {
      compositorRoot = resolve(
        Bun.resolveSync(`${compositorName}/package.json`, join(import.meta.dir, "build-deps")),
        "..",
      );
    } catch {
      throw new Error(
        `Install optional ${compositorName}@${renderer.version} in .aphrody/build-deps or set BUN_VIDEO_COMPOSITOR_DIR`,
      );
    }
  }
  if (compositorName && compositorRoot) {
    compositorRoot = resolve(compositorRoot);
    const manifest = await Bun.file(join(compositorRoot, "package.json")).json();
    if (manifest.name !== compositorName || manifest.version !== renderer.version)
      throw new Error(`Compositor assets must match ${compositorName}@${renderer.version}`);
  }
  const workspaces = new Map<string, { root: string; manifest: Record<string, any> }>();
  for (const { directory: root, manifest } of await familyModules(remotionRoot))
    if (manifest.name) workspaces.set(manifest.name, { root, manifest });
  return {
    name: "remotion-vendored-source",
    setup(build) {
      build.onResolve({ filter: /^(?:@remotion\/|remotion(?:\/|$))/ }, ({ path }) => {
        // These Remotion Studio integrations are installed by users on demand.
        // Keep their lazy imports external so a base Bun Video install needs no model package.
        if (
          path === "@remotion/whisper-webgpu" ||
          path.startsWith("@remotion/whisper-webgpu/") ||
          path === "@remotion/video-matting" ||
          path.startsWith("@remotion/video-matting/")
        )
          return { path, external: true };
        if (path === compositorName && compositorRoot) {
          return { path, namespace: "remotion-native-compositor" };
        }
        const parts = path.split("/");
        const name = path.startsWith("@") ? parts.splice(0, 2).join("/") : parts.shift()!;
        const workspace = workspaces.get(name);
        if (!workspace) return;
        const subpath = parts.length ? "./" + parts.join("/") : ".";
        if (subpath === "./package.json") return { path, namespace: "remotion-module-manifest" };
        let entry = workspace.manifest.exports?.[subpath];
        if (typeof entry === "object")
          entry = entry.import ?? entry.module ?? entry.require ?? entry.default;
        if (typeof entry !== "string") entry = subpath === "." ? workspace.manifest.main : subpath;
        entry = (entry ?? "./dist/index.js")
          .replace(/^\.\//, "")
          .replace(/^dist\/(?:cjs\/|esm\/)?/, "src/");
        const stem = join(workspace.root, entry.replace(/\.(?:m?js|cjs)$/, ""));
        const candidates = [
          stem + ".ts",
          stem + ".tsx",
          stem + ".js",
          stem + ".mjs",
          join(stem, "index.ts"),
          join(stem, "index.tsx"),
          join(workspace.root, entry),
        ];
        const found = candidates.find(existsSync);
        if (!found) throw new Error(`No vendored source for ${path}: ${candidates.join(", ")}`);
        return { path: found };
      });
      build.onLoad({ filter: /.*/, namespace: "remotion-module-manifest" }, ({ path }) => {
        const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0]!;
        return { loader: "json", contents: JSON.stringify(workspaces.get(name)!.manifest) };
      });
      build.onLoad({ filter: /.*/, namespace: "remotion-native-compositor" }, () => {
        if (!compositorRoot || !existsSync(compositorRoot)) {
          throw new Error(
            "Install the pinned optional compositor package or set BUN_VIDEO_COMPOSITOR_DIR before compilation",
          );
        }
        const executables = ["remotion", "ffmpeg", "ffprobe"].map(
          name => name + target.executableSuffix,
        );
        const files = readdirSync(compositorRoot).filter(
          name => executables.includes(name) || /\.(exe|dll|so(?:\.\d+)*)$/.test(name),
        );
        if (executables.some(name => !files.includes(name))) {
          throw new Error(
            "The compositor asset directory must contain its native remotion, ffmpeg and ffprobe executables",
          );
        }
        const imports = files
          .map(
            (name, index) =>
              `import asset${index} from ${JSON.stringify(join(compositorRoot, name))} with {type: "file"};`,
          )
          .join("\n");
        const writes = files
          .map(
            (name, index) =>
              `writeFileSync(join(dir, ${JSON.stringify(name)}), readFileSync(asset${index}), {mode:${executables.includes(name) ? "0o700" : "0o600"}});`,
          )
          .join("\n");
        return {
          loader: "js",
          contents: `${imports}\nimport {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';\nimport {tmpdir} from 'node:os';\nimport {join} from 'node:path';\nexport const dir = mkdtempSync(join(tmpdir(), 'bun-video-compositor-'));\ntry {${writes}} catch(error) {rmSync(dir, {recursive:true}); throw error;}\nprocess.once('exit', () => rmSync(dir, {recursive:true}));\n`,
        };
      });
      build.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
        if (!importer.startsWith(remotionRoot)) return;
        if (path.startsWith("node:") || path.startsWith("bun:") || path === "bun") return;
        try {
          return { path: Bun.resolveSync(path, join(import.meta.dir, "build-deps")) };
        } catch {
          return;
        }
      });
    },
  };
}

export async function buildRemotionStandalone(outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "standalone-entry.ts")],
    plugins: [await remotionSourcePlugin(), await remotionModuleAssetsPlugin()],
    target: "bun",
    minify: true,
    compile: { outfile: resolve(outfile), executablePath: process.execPath },
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Remotion standalone compilation failed");
}

if (import.meta.main) {
  await buildRemotionStandalone(
    process.argv[2] ?? resolve(remotionRoot, "../../../tmp/bun-video-build/remotion.exe"),
  );
}
