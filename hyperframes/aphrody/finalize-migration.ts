import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packages: unknown[] = [];
for await (const path of new Bun.Glob("**/package.json").scan({ cwd: root, dot: true })) {
  if (path.startsWith("aphrody/")) continue;
  const file = Bun.file(join(root, path));
  const manifest = await file.json();
  if (!manifest.name) continue;
  const before = JSON.stringify(manifest);
  for (const [key, value] of Object.entries(manifest.scripts ?? {})) {
    if (typeof value !== "string") continue;
    let command = value.replace(/\bnode\s+(?:--import\s+tsx\s+)?--test\s+/g, "bun test ")
      .replace(/\bnode\s+--import\s+tsx\s+/g, "bun ")
      .replace(/\bnode\s+(?=[^\s-])/g, "bun ")
      .replace(/\btsx\s+/g, "bun ");
    // Node preload registration is not a Bun test preload contract.
    command = command.replace(/\bnode\s+--import\s+(\S+)\s+--test\s+/g, "bun test --preload $1 ");
    manifest.scripts[key] = command;
  }
  manifest.engines = { ...manifest.engines, bun: ">=1.4.3" };
  if (path === "package.json") {
    manifest.packageManager = "bun@1.4.3";
    manifest.scripts.prepare = "bun -e \"console.log('Vendored source: repository hooks are managed by the owner checkout')\"";
  }
  if (JSON.stringify(manifest) !== before) await Bun.write(file, JSON.stringify(manifest, null, 2) + "\n");
  packages.push({ path, name: manifest.name, scripts: manifest.scripts });
}
const runnerFiles: string[] = [];
for (const pattern of ["**/*.sh", ".github/workflows/*.{yml,yaml}"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: true })) {
    const file = Bun.file(join(root, path));
    const source = await file.text();
    const output = source.split("\n").map((line) => {
      if (line.trimStart().startsWith("#")) return line;
      return line.replace(/\bbunx\s+tsx\s+/g, "bun ")
        .replace(/\bnode\s+--import\s+tsx\s+--test\s+/g, "bun test ")
        .replace(/\bnode\s+--test\s+/g, "bun test ")
        .replace(/\bnode\s+(?=[\"'$./\w-])/g, "bun ");
    }).join("\n");
    if (output !== source) { await Bun.write(file, output); runnerFiles.push(path); }
  }
}
await Bun.write(join(import.meta.dir, "workspaces.json"), JSON.stringify(packages, null, 2) + "\n");
await Bun.write(join(import.meta.dir, "runner-files.json"), JSON.stringify(runnerFiles, null, 2) + "\n");
console.log(JSON.stringify({ packages: packages.length, runnerFiles: runnerFiles.length }));
