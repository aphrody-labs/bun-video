import { resolve } from "node:path";

/** The embedded formatter has no HTML/Vue/Prettier plugin backend. */
export async function formatSourcePaths(root: string): Promise<string[]> {
  const paths = Array.from(
    new Bun.Glob(
      "{src,test,scripts}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,json,jsonc,json5,css,graphql,gql,md,yaml,yml,toml}",
    ).scanSync({
      cwd: root,
      onlyFiles: true,
      followSymlinks: false,
    }),
  ).sort();
  if (!paths.length || paths.length > 2000) throw new Error("Expected a bounded set of package format sources");
  return paths;
}

export async function checkPackageFormat(root = resolve(import.meta.dir, "..")): Promise<number> {
  const paths = await formatSourcePaths(root);
  const child = Bun.spawn([process.execPath, "fmt", "--check", ...paths], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 30_000,
  });
  const exitCode = await child.exited;
  if (child.signalCode) throw new Error("Package formatter exceeded its bounded execution");
  return exitCode;
}

if (import.meta.main) process.exitCode = await checkPackageFormat();
