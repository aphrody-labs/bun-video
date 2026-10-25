import { join, relative, resolve } from "node:path";
import { absorbedFamilies } from "./modules";
import { runtimeClosure } from "./runtime-closure";

/** Family tsconfig files that every absorbed module extends; their paths replace workspace links. */
export const familyConfigs = { remotion: "tsconfig.settings.json", hyperframes: "tsconfig.base.json" } as const;

/** Map every absorbed module specifier to its source, relative to each family directory. */
export async function writeFamilyConfigs(root = resolve(import.meta.dir, "..")) {
  const { modulePaths } = await runtimeClosure(root);
  for (const family of absorbedFamilies) {
    const file = join(root, family, familyConfigs[family]);
    const config: { compilerOptions?: { paths?: Record<string, string[]> } } = (await Bun.file(file).exists())
      ? (Bun.JSONC.parse(await Bun.file(file).text()) as object)
      : {};
    config.compilerOptions ??= {};
    config.compilerOptions.paths = Object.fromEntries(
      Object.entries(modulePaths).map(([name, [path]]) => [
        name,
        [
          relative(join(root, family), join(root, path!))
            .replaceAll("\\", "/")
            .replace(/^(?!\.)/, "./"),
        ],
      ]),
    );
    await Bun.write(file, JSON.stringify(config, null, "\t") + "\n");
  }
}

if (import.meta.main) await writeFamilyConfigs();
