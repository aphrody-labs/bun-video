// Type-checks the package with the native `bun check` and fails only on diagnostics in code this
// package owns.
//
// remotion/, hyperframes/ and mediabunny/ are upstream source copies and yt-dlp/ holds vendored
// tooling. They are reachable through tsconfig `paths`, so tsc loads them transitively and
// `include`/`exclude` cannot keep them out. Their diagnostics come from the upstream build
// environment (own tsconfig, React 18/19 ref typings, optional packages such as ajv or onnxruntime
// that are not installed here), not from defects of this package; patching them would fork the
// upstream sources. node_modules is third-party code for the same reason.
import { resolve } from "node:path";

export const VENDORED_PREFIXES = ["remotion/", "hyperframes/", "mediabunny/", "yt-dlp/", "node_modules/"];

export interface Diagnostic {
  file: string;
  line: string;
}

/** Splits `bun check --no-pretty` output into per-file diagnostics. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error TS\d+:/.exec(line);
    if (match) found.push({ file: match[1]!.replaceAll("\\", "/").replace(/^\.\//, ""), line });
  }
  return found;
}

export function ownedDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(({ file }) => !VENDORED_PREFIXES.some(prefix => file.startsWith(prefix)));
}

export async function checkProject(root: string, project: string): Promise<{ owned: Diagnostic[]; vendored: number }> {
  const child = Bun.spawn(
    [process.execPath, "check", "--threads=1", "--project", project, "--noEmit", "--no-pretty", "--all"],
    { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 600_000 },
  );
  const [stdout, stderr] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  const all = parseDiagnostics(`${stdout}\n${stderr}`);
  if (child.exitCode !== 0 && all.length === 0) {
    throw new Error(`bun check ${project} failed without diagnostics:\n${stdout}${stderr}`);
  }
  const owned = ownedDiagnostics(all);
  return { owned, vendored: all.length - owned.length };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  let failed = 0;
  for (const project of ["tsconfig.check.json", "tsconfig.scripts.check.json"]) {
    const { owned, vendored } = await checkProject(root, project);
    for (const { line } of owned) console.error(line);
    console.log(`${project}: ${owned.length} owned error(s), ${vendored} vendored diagnostic(s) ignored`);
    failed += owned.length;
  }
  process.exitCode = failed ? 1 : 0;
}
