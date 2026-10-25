import { join, resolve } from "node:path";
import { planRemotionLibraryAssets } from "../remotion/.aphrody/module-assets-scope";
import { runtimeClosure } from "./runtime-closure";
import { publicPackageFile } from "./package-file-policy";

/** Literal positive file names avoid relying on the packer's negative recursive glob behavior. */
export async function packagePublicFiles(root = resolve(import.meta.dir, "..")) {
  const closure = await runtimeClosure(root);
  if (closure.missing.length) throw new Error("Public source closure is incomplete");
  const physical = await planRemotionLibraryAssets(join(root, "remotion"), [
    "@remotion/cli",
    "@remotion/renderer",
    "remotion",
  ]);
  const trees = new Set(["src", "umbrella-src", "native", "infra", "plugin", "scripts", "docs", "assets"]);
  const files = new Set(["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "tsconfig.json"]);
  const manifest = await Bun.file(join(root, "package.json")).json();
  for (const path of Object.values(manifest.patchedDependencies ?? {}) as string[]) {
    if (!path.startsWith("patches/") || path.includes("..") || path.includes("\\") || !path.endsWith(".patch"))
      throw new Error("Public dependency patch escapes its owner");
    if (!(await Bun.file(join(root, path)).exists())) throw new Error("Public dependency patch is absent");
    files.add(path);
  }
  const config = Bun.JSONC.parse(await Bun.file(join(root, "tsconfig.json")).text()) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  for (const paths of Object.values(config.compilerOptions?.paths ?? {})) {
    for (const path of paths) {
      if (
        !path.startsWith("./") ||
        path.includes("\\") ||
        path
          .slice(2)
          .split("/")
          .some(part => !part || part === "." || part === "..") ||
        !publicPackageFile(path)
      )
        throw new Error("Public runtime mapping escapes the package file policy");
      if (!(await Bun.file(join(root, path)).exists())) throw new Error("Public runtime mapping is absent");
      files.add(path.slice(2));
    }
  }
  for (const path of Object.values(manifest.bunVideo.sourceBins) as string[]) files.add(path.slice(2));
  for (const path of closure.sourceFileNames) files.add(path);
  for (const owner of physical.owners.filter(owner => owner.workspace)) {
    const directory = owner.directory.slice(join(root, "remotion").length + 1).replaceAll("\\", "/");
    trees.add("remotion/" + directory + "/src");
  }
  for (const path of closure.sourceFileNames) {
    const directory = path.match(/^(hyperframes\/[^/]+|mediabunny)\/src\//)?.[1];
    if (directory) trees.add(directory + "/src");
  }
  for (const directory of ["remotion/.aphrody", "hyperframes/aphrody"])
    for await (const name of new Bun.Glob("*.{ts,md}").scan({
      cwd: join(root, directory),
      onlyFiles: true,
      followSymlinks: false,
    }))
      files.add(directory + "/" + name);
  for (const path of [
    "remotion/modules.json",
    "hyperframes/modules.json",
    "remotion/LICENSE.md",
    "hyperframes/LICENSE",
    "mediabunny/package.json",
    "mediabunny/LICENSE",
    "remotion/.aphrody/build-deps/package.json",
    "remotion/.aphrody/build-deps/bun.lock",
    "remotion/bundler/favicon.ico",
    "yt-dlp/LICENSE",
    "yt-dlp/README.md",
    "yt-dlp/pyproject.toml",
    "yt-dlp/public.key",
  ])
    if (await Bun.file(join(root, path)).exists()) files.add(path);
  trees.add("mediabunny/shared");
  trees.add("yt-dlp/yt_dlp");
  for (const tree of trees)
    for await (const name of new Bun.Glob("**/*").scan({
      cwd: join(root, tree),
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const path = tree + "/" + name.replaceAll("\\", "/");
      if (publicPackageFile(path)) files.add(path);
      if (files.size > 7000) throw new Error("Public package source exceeds its file bound");
    }
  return ["dist", ...[...files].filter(publicPackageFile).sort()];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const file = join(root, "package.json");
  const manifest = await Bun.file(file).json();
  manifest.files = await packagePublicFiles(root);
  await Bun.write(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ publicFiles: manifest.files.length }));
}
