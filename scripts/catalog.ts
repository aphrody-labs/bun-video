import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entries: { project: string; path: string; sha256: string; kind: string }[] = [];
for (const project of ["remotion", "hyperframes"]) {
  const projectRoot = resolve(root, project);
  for (const pattern of ["**/*.md", "**/*.mdx"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: projectRoot, onlyFiles: true })) {
      const normalized = path.replaceAll("\\", "/");
      if (/(^|\/)(node_modules|dist|target|build|\.aphrody|aphrody)(\/|$)/.test(normalized)) continue;
      const content = await Bun.file(resolve(projectRoot, path)).arrayBuffer();
      entries.push({
        project,
        path: `${project}/${normalized}`,
        sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        kind: normalized.endsWith("SKILL.md") ? "skill" : "documentation",
      });
    }
  }
}
entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
await Bun.write(resolve(root, "docs/catalog.json"), JSON.stringify({ schema: 1, entries }, null, 2) + "\n");
console.log(
  JSON.stringify({
    documents: entries.length,
    uniqueContents: new Set(entries.map(entry => entry.sha256)).size,
  }),
);
