import { join } from "node:path";

const root = join(import.meta.dir, "..");
const baseline = Bun.env.HYPERFRAMES_UPSTREAM_ROOT;
if (!baseline) throw new Error("Set HYPERFRAMES_UPSTREAM_ROOT to the pinned upstream checkout before reviewing a fresh n2b report");
const reportPath = Bun.env.HYPERFRAMES_N2B_REPORT;
if (!reportPath) throw new Error("Set HYPERFRAMES_N2B_REPORT to the detailed aggressive n2b JSON report");
const report = await Bun.file(reportPath).json();
const retained = new Set(["shebang/node", "imports/node-prefix", "api/dirname-esm", "api/filename-esm", "cli/npx", "cli/npm-install", "cli/npm-i", "cli/npm-uninstall", "cli/npm-pack"]);
const decisions: unknown[] = [];
for (const file of report.files) {
  if (!file.changed) continue;
  const proc = Bun.spawn(["git", "-C", baseline, "show", `HEAD:${file.path}`], { stdout: "pipe", stderr: "pipe" });
  const [source, stderr, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(stderr);
  const fixes = file.findings.filter((finding: any) => finding.autofix && finding.replacement && retained.has(finding.rule_id)).sort((a: any, b: any) => b.start_byte - a.start_byte);
  const lines = Buffer.from(source).toString().split("\n");
  const seen = new Set<string>();
  for (const fix of fixes) {
    const key = `${fix.line}:${fix.original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = [fix.line - 1, fix.line, fix.line - 2, fix.line + 1].find((index: number) => lines[index]?.includes(fix.original));
    if (index === undefined) throw new Error(`Stale edit ${file.path}:${fix.line}`);
    lines[index] = fix.rule_id === "imports/node-prefix"
      ? lines[index].replace(new RegExp(`(["'])${fix.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g"), (_match, quote) => `${quote}${fix.replacement}${quote}`)
      : lines[index].split(fix.original).join(fix.replacement);
  }
  await Bun.write(join(root, file.path), lines.join("\n"));
  decisions.push({ path: file.path, retainedRules: fixes.map((f: any) => f.rule_id), deferredRules: [...new Set(file.findings.filter((f: any) => f.autofix && f.replacement && !retained.has(f.rule_id)).map((f: any) => f.rule_id))] });
}
await Bun.write(join(import.meta.dir, "reviewed-edits.json"), JSON.stringify({ reason: "Preserve synchronous I/O, Buffer semantics, browser code, published dependencies, CI and compiler contracts; asynchronous/native rewrites need individual semantic qualification.", decisions }, null, 2) + "\n");
console.log(JSON.stringify({ reviewedFiles: decisions.length }));
