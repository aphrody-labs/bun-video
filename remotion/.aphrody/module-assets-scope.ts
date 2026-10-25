import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { familyCatalog, familyManifests } from "../../scripts/modules";

type Manifest = {
  name: string;
  version: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
type Owner = {
  name: string;
  directory: string;
  destination: string;
  manifest: Manifest;
  workspace: boolean;
};

function compatible(values: string[] | undefined, host: string) {
  if (!values) return true;
  return !values.includes("!" + host) && (!values.some(value => !value.startsWith("!")) || values.includes(host));
}

/** The C library that installed Linux native variants must match; other platforms declare none. */
function hostLibc(): string | undefined {
  if (process.platform !== "linux") return;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return header?.glibcVersionRuntime ? "glibc" : "musl";
}

async function packageDirectory(name: string, directory: string): Promise<string | undefined> {
  try {
    return dirname(Bun.resolveSync(name + "/package.json", directory));
  } catch {}
  try {
    let current = dirname(Bun.resolveSync(name, directory));
    while (dirname(current) !== current) {
      const file = join(current, "package.json");
      if ((await Bun.file(file).exists()) && (await Bun.file(file).json()).name === name) return current;
      current = dirname(current);
    }
  } catch {}
}

/** Close the browser resolver's physical packages using their own manifests and exact installed variants. */
export async function planRemotionLibraryAssets(root: string, seeds: readonly string[]) {
  root = resolve(root);
  const catalog = await familyCatalog(root);
  const workspaces = new Map<string, Owner>();
  for (const [name, absorbed] of Object.entries(await familyManifests(root))) {
    const directory = join(root, name);
    if (!existsSync(join(directory, "src"))) continue;
    const manifest = absorbed as Manifest;
    if (manifest.name)
      workspaces.set(manifest.name, {
        name: manifest.name,
        directory,
        destination: "node_modules/" + manifest.name,
        manifest,
        workspace: true,
      });
  }
  const registry = join(root, ".aphrody/build-deps");
  const owners = new Map<string, Owner>();
  const destinations = new Map<string, string>();
  const queue: Array<{
    name: string;
    from: string;
    parent?: Owner;
    constraint?: string;
    optional?: boolean;
  }> = seeds.map(name => ({ name, from: registry }));
  const skipped: Array<{ name: string; reason: string }> = [];
  const selected = new Set(seeds);
  while (queue.length) {
    if (owners.size > 1000 || queue.length > 6000)
      throw new Error("Physical module dependency closure exceeds its bound");
    const item = queue.shift()!;
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(item.name)) throw new Error("Unsafe physical package name");
    const workspace = workspaces.get(item.name);
    const directory = workspace?.directory ?? (await packageDirectory(item.name, item.from));
    if (!directory) {
      if (item.optional) {
        skipped.push({ name: item.name, reason: "optional-not-installed" });
        continue;
      }
      throw new Error(`Missing physical runtime dependency ${item.name}`);
    }
    const path = realpathSync(directory);
    const manifest = workspace?.manifest ?? ((await Bun.file(join(path, "package.json")).json()) as Manifest);
    if (manifest.name !== item.name) throw new Error("Physical package name differs from its dependency");
    if (
      !compatible(manifest.os, process.platform) ||
      !compatible(manifest.cpu, process.arch) ||
      (manifest.libc && !compatible(manifest.libc, hostLibc() ?? ""))
    ) {
      if (workspace || item.optional) {
        skipped.push({ name: item.name, reason: "foreign-platform" });
        continue;
      }
      throw new Error(`Foreign physical runtime dependency ${item.name}`);
    }
    const constraint = item.constraint === "catalog:" ? catalog[item.name] : item.constraint;
    if (item.constraint === "catalog:" && !constraint)
      throw new Error(`Missing physical dependency catalog pin: ${item.name}`);
    if (constraint && !constraint.startsWith("workspace:") && !Bun.semver.satisfies(manifest.version, constraint))
      throw new Error(`Physical dependency pin differs for ${item.name}: ${manifest.version} versus ${constraint}`);
    if (owners.has(path)) continue;
    let destination = workspace?.destination ?? "node_modules/" + item.name;
    if (destinations.has(destination) && destinations.get(destination) !== path) {
      if (!item.parent) throw new Error("Conflicting physical package roots");
      destination = item.parent.destination + "/node_modules/" + item.name;
    }
    if (destinations.has(destination) && destinations.get(destination) !== path)
      throw new Error("Conflicting physical dependency variants");
    const owner = {
      name: item.name,
      directory: path,
      destination,
      manifest,
      workspace: !!workspace,
    };
    destinations.set(destination, path);
    owners.set(path, owner);
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    // Absorbed modules have no node_modules of their own: their externals are the registry's pins.
    const from = owner.workspace ? registry : path;
    for (const [name, constraint] of Object.entries(dependencies))
      queue.push({
        name,
        from,
        parent: owner,
        constraint,
        optional: name in (manifest.optionalDependencies ?? {}),
      });
    for (const [name, constraint] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name in dependencies) continue;
      if (manifest.peerDependenciesMeta?.[name]?.optional === true && !selected.has(name)) {
        skipped.push({ name, reason: "optional-peer-not-selected" });
        continue;
      }
      queue.push({
        name,
        from,
        parent: owner,
        constraint,
        optional: manifest.peerDependenciesMeta?.[name]?.optional === true,
      });
    }
  }
  const files: Array<{ source: string; destination: string; transpile: boolean }> = [];
  let bytes = 0;
  // Physical owners may be realpaths in the package-manager store, so protected-path checks are owner-relative.
  function inventory(source: string, destination: string, transpile: boolean, base: string) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        /^(?:test|tests|__tests__|fixtures|testdata|visual-test)$/.test(entry.name)
      )
        continue;
      const from = join(source, entry.name);
      const to = join(destination, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) inventory(from, to, transpile, base);
      else if (entry.isFile() && !/\.d\.ts$|\.map$|\.(?:test|spec)\.[^.]+$/.test(entry.name)) {
        const member = relative(base, from);
        if (
          isAbsolute(member) ||
          member.startsWith("..") ||
          /(?:^|[\\/])(?:cookies|sessions|\.env[^\\/]*|\.local)(?:[\\/]|$)|\.(?:har|sqlite|safetensors|gguf)$/i.test(
            member,
          )
        )
          throw new Error(`Protected or external physical module input: ${member}`);
        bytes += Bun.file(from).size;
        if (files.length >= 12000 || bytes > 160 * 1024 * 1024)
          throw new Error(`Scoped physical module assets exceed their payload bound at ${to}: ${bytes} bytes`);
        files.push({ source: from, destination: to, transpile });
      }
    }
  }
  for (const owner of owners.values()) {
    if (owner.workspace) inventory(join(owner.directory, "src"), owner.destination + "/src", true, resolve(root, "../.."));
    else inventory(owner.directory, owner.destination, false, owner.directory);
  }
  return { owners: [...owners.values()], files, bytes, skipped };
}
