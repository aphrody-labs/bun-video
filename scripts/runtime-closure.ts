import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { absorbedFamilies, familyModules } from "./modules";

type Manifest = {
  name: string;
  version: string;
  main?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: Record<string, string>;
  workspaces?: { catalog?: Record<string, string> };
  bunVideo?: { sourceExports: Record<string, string>; sourceBins: Record<string, string> };
};

function sourceEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return;
  const conditions = value as Record<string, unknown>;
  for (const key of ["bun", "import", "module", "require", "default"]) {
    const entry = sourceEntry(conditions[key]);
    if (entry) return entry;
  }
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith("../") && !name.startsWith("..\\") && !isAbsolute(name);
}

/** Derive source mappings and direct runtime pins from the existing workspace owners. */
export async function runtimeClosure(root: string) {
  root = resolve(root);
  const manifest = (await Bun.file(join(root, "package.json")).json()) as Manifest;
  const lock = Bun.JSONC.parse(await Bun.file(join(root, "bun.lock")).text()) as {
    packages: Record<string, [string, ...unknown[]]>;
  };
  const owners = [{ directory: root, manifest }];
  for (const family of absorbedFamilies)
    for (const module of await familyModules(join(root, family))) owners.push(module as (typeof owners)[number]);
  owners.push({
    directory: join(root, "mediabunny"),
    manifest: await Bun.file(join(root, "mediabunny/package.json")).json(),
  });
  owners.sort((a, b) => b.directory.length - a.directory.length);
  const paths: Record<string, string[]> = {};
  const entries = new Map<string, string>();
  const exists = new Map<string, boolean>();
  async function regular(path: string) {
    if (!inside(root, path)) return false;
    if (!exists.has(path)) exists.set(path, await Bun.file(path).exists());
    return exists.get(path)!;
  }
  async function resolveSource(stem: string): Promise<string | undefined> {
    const sourceStem = stem.replace(/\.(?:mjs|cjs|js)$/, "");
    for (const path of [
      stem,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map(ext => sourceStem + ext),
      join(stem, "index.ts"),
      join(stem, "index.tsx"),
      join(stem, "index.js"),
    ]) {
      if (await regular(path)) return path;
    }
  }
  for (const owner of owners) {
    const raw =
      owner.directory === root ? (manifest.bunVideo?.sourceExports ?? owner.manifest.exports) : owner.manifest.exports;
    const declared =
      raw && typeof raw === "object" && Object.keys(raw).some(key => key.startsWith("."))
        ? (raw as Record<string, unknown>)
        : { ".": raw ?? owner.manifest.main };
    for (const [subpath, value] of Object.entries(declared)) {
      const entry = sourceEntry(value);
      if (!entry || !subpath.startsWith(".") || subpath.includes("*")) continue;
      const normalized = entry.replace(/^\.\/dist\/(?:cjs\/|esm\/|modules\/)?/, "./src/");
      const stem = resolve(owner.directory, normalized.replace(/\.(?:mjs|cjs|js)$/, ""));
      const found = (await resolveSource(stem)) ?? (await resolveSource(resolve(owner.directory, entry)));
      if (!found) continue;
      const specifier = owner.manifest.name + (subpath === "." ? "" : subpath.slice(1));
      entries.set(specifier, found);
      if (owner.directory !== root) paths[specifier] = ["./" + relative(root, found).replaceAll("\\", "/")];
    }
    // Mediabunny's published dist layout differs from its absorbed src layout.
    if (owner.manifest.name === "mediabunny") {
      const path = join(owner.directory, "src/index.ts");
      if (!(await regular(path))) throw new Error("The absorbed Mediabunny source is absent");
      entries.set("mediabunny", path);
      paths.mediabunny = ["./mediabunny/src/index.ts"];
    }
  }
  const dependencies = { ...manifest.dependencies };
  const queue = [
    ...Object.values(manifest.bunVideo?.sourceExports ?? (manifest.exports as Record<string, string>)),
    ...Object.values(manifest.bunVideo?.sourceBins ?? manifest.bin ?? {}),
  ].map(path => resolve(root, path));
  const usedAliases = new Set<string>();
  const scanned = new Set<string>();
  const missing: Array<{ source: string; import: string }> = [];
  const optionalPeers = new Set<string>();
  const virtual = new Set<string>();
  const requirements = new Map<string, Set<string>>();
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts", tsconfig: { compilerOptions: { jsx: "react" } } }),
    tsx: new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }),
  };
  while (queue.length) {
    const path = queue.pop()!;
    if (scanned.has(path) || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) continue;
    if (scanned.size >= 6000) throw new Error("Runtime source closure exceeds its bounded graph");
    scanned.add(path);
    if (!(await regular(path))) {
      missing.push({ source: relative(root, path), import: "entrypoint" });
      continue;
    }
    const file = Bun.file(path);
    if (file.size > 4 * 1024 * 1024) throw new Error("Runtime source file exceeds its bounded input");
    const owner = owners.find(owner => inside(owner.directory, path))!;
    let imports: ReturnType<Bun.Transpiler["scanImports"]>;
    try {
      imports = transpilers[path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "ts"].scanImports(
        await file.text(),
      );
    } catch (error) {
      throw new Error(`Runtime import scan failed for ${relative(root, path)}: ${String(error)}`);
    }
    for (const imported of imports) {
      const specifier = imported.path;
      if (isBuiltin(specifier) || /^(?:bun|buv):/.test(specifier) || specifier === "bun") continue;
      if (specifier.startsWith("bun-video:")) {
        virtual.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        const found = await resolveSource(resolve(dirname(path), specifier));
        if (found) queue.push(found);
        else missing.push({ source: relative(root, path), import: specifier });
        continue;
      }
      const local = entries.get(specifier);
      if (local) {
        if (paths[specifier]) usedAliases.add(specifier);
        queue.push(local);
        continue;
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      if (owners.some(owner => owner.manifest.name === name)) {
        missing.push({ source: relative(root, path), import: specifier });
        continue;
      }
      if (manifest.peerDependenciesMeta?.[name]?.optional) {
        optionalPeers.add(name);
        continue;
      }
      const declared =
        owner.manifest.dependencies?.[name] ??
        owner.manifest.optionalDependencies?.[name] ??
        owner.manifest.peerDependencies?.[name] ??
        owner.manifest.devDependencies?.[name];
      const constraint = declared === "catalog:" ? manifest.workspaces?.catalog?.[name] : declared;
      if (constraint) {
        if (!requirements.has(name)) requirements.set(name, new Set());
        requirements.get(name)!.add(constraint);
      }
      if (dependencies[name]) continue;
      if (!declared) {
        missing.push({ source: relative(root, path), import: specifier });
        continue;
      }
      const versions = Object.entries(lock.packages)
        .filter(([key, value]) => (key === name || key.endsWith("/" + name)) && value[0].startsWith(name + "@"))
        .map(([, value]) => value[0].slice(name.length + 1))
        .filter(version => constraint && Bun.semver.satisfies(version, constraint))
        .sort((a, b) => Bun.semver.order(b, a));
      const version = versions[0];
      if (!version) {
        missing.push({ source: relative(root, path), import: specifier });
        continue;
      }
      dependencies[name] = version;
    }
  }
  return {
    paths: Object.fromEntries(
      Object.entries(paths)
        .filter(([name]) => usedAliases.has(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    modulePaths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    sourceFiles: scanned.size,
    sourceFileNames: [...scanned].map(path => relative(root, path).replaceAll("\\", "/")).sort(),
    optionalPeers: [...optionalPeers].sort(),
    runtimeModules: [...virtual].sort(),
    conflicts: [...requirements.entries()]
      .filter(
        ([name, constraints]) =>
          dependencies[name] &&
          [...constraints].some(constraint => !Bun.semver.satisfies(dependencies[name]!, constraint)),
      )
      .map(([name, constraints]) => ({ name, selected: dependencies[name], constraints: [...constraints].sort() })),
    missing,
  };
}

if (import.meta.main) {
  try {
    const result = await runtimeClosure(resolve(import.meta.dir, ".."));
    console.log(JSON.stringify(result, null, 2));
    if (result.missing.length) process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
