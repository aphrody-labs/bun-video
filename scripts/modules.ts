import { join, resolve } from "node:path";

export type ModuleManifest = {
  name: string;
  version: string;
  main?: string;
  module?: string;
  types?: string;
  type?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

export type AbsorbedModule = { directory: string; manifest: ModuleManifest };

/** Families whose upstream workspaces are absorbed as plain directories with one shared manifest. */
export const absorbedFamilies = ["remotion", "hyperframes"] as const;

export type FamilyManifest = {
  upstream: string;
  catalog?: Record<string, string>;
  modules: Record<string, ModuleManifest>;
};

const cache = new Map<string, Promise<FamilyManifest>>();

/** The shared `modules.json` of an absorbed family. */
export function familyManifest(familyRoot: string): Promise<FamilyManifest> {
  familyRoot = resolve(familyRoot);
  let entry = cache.get(familyRoot);
  if (!entry) {
    entry = Bun.file(join(familyRoot, "modules.json")).json();
    cache.set(familyRoot, entry);
  }
  return entry;
}

/** Module manifests of an absorbed family, keyed by module directory name. */
export async function familyManifests(familyRoot: string): Promise<Record<string, ModuleManifest>> {
  return (await familyManifest(familyRoot)).modules;
}

/** Version pins that module `catalog:` dependencies refer to. */
export async function familyCatalog(familyRoot: string): Promise<Record<string, string>> {
  return (await familyManifest(familyRoot)).catalog ?? {};
}

/** Absorbed modules of a family with absolute directories. */
export async function familyModules(familyRoot: string): Promise<AbsorbedModule[]> {
  familyRoot = resolve(familyRoot);
  return Object.entries(await familyManifests(familyRoot)).map(([name, manifest]) => ({
    directory: join(familyRoot, name),
    manifest,
  }));
}

/** The manifest of one absorbed module directory, or undefined. */
export async function moduleManifest(familyRoot: string, directory: string): Promise<ModuleManifest | undefined> {
  return (await familyManifests(familyRoot))[directory];
}
