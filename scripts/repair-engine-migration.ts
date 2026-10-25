import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const log = Bun.argv[2];
if (!log) throw new Error("Expected the check-engines JSON diagnostic log");
const apply = Bun.argv.includes("--apply");
const files = new Map<string, Set<number>>();
for (const line of (await Bun.file(log).text()).split("\n")) {
  if (!line.startsWith('{"file"')) continue;
  const issue = JSON.parse(line) as { file: string; line?: number };
  if (!issue.line) continue;
  const path = resolve(root, issue.file);
  if (!["remotion", "hyperframes"].some(engine => path.startsWith(resolve(root, engine) + sep)))
    throw new Error("Diagnostic outside absorbed engines");
  const lines = files.get(path) ?? new Set<number>();
  lines.add(issue.line);
  files.set(path, lines);
}

function closingParen(source: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  throw new Error("Unbalanced native file call");
}

for (const [path] of files) {
  const original = await Bun.file(path).text();
  let source = original;
  let repaired = 0;
  const transpiler = new Bun.Transpiler({
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
    target: "bun",
    tsconfig: { compilerOptions: { jsx: "react" } },
  });
  for (let pass = 0; pass < 100; pass++) {
    const lines = new Set<number>();
    try {
      transpiler.transformSync(source);
      break;
    } catch (error) {
      for (const issue of error instanceof AggregateError ? error.errors : [error]) {
        if (issue?.position?.line) lines.add(issue.position.line);
      }
    }
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    const hasFs = /import\s+(?:\*\s+as\s+fs\s+from|fs\s*(?:,|from))\s*/.test(source);
    const hasEngineFs = /import\s+\*\s+as\s+engineFs\s+from/.test(source);
    const binding = hasFs ? "fs" : "engineFs";
    for (const match of source.matchAll(/\bawait\s+Bun\.(file|write)\s*\(/g)) {
      const start = match.index;
      if (!lines.has(source.slice(0, start).split("\n").length)) continue;
      const open = start + match[0].length - 1;
      const close = closingParen(source, open);
      const args = source.slice(open + 1, close);
      if (match[1] === "write") {
        edits.push({ start, end: close + 1, replacement: `${binding}.writeFileSync(${args})` });
        continue;
      }
      const method = /^\.(exists|text|json)\(\)/.exec(source.slice(close + 1));
      if (!method) continue;
      const replacement =
        method[1] === "exists"
          ? `${binding}.existsSync(${args})`
          : method[1] === "text"
            ? `${binding}.readFileSync(${args}, "utf8")`
            : `JSON.parse(${binding}.readFileSync(${args}, "utf8"))`;
      edits.push({ start, end: close + 1 + method[0].length, replacement });
    }
    if (!edits.length) break;
    let result = source;
    for (const edit of edits.reverse())
      result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    if (!hasFs && !hasEngineFs) result = 'import * as engineFs from "node:fs";\n' + result;
    source = result;
    repaired += edits.length;
  }
  if (!repaired) continue;
  console.log(JSON.stringify({ path, synchronousContractsRepaired: repaired, apply }));
  if (apply) {
    if ((await Bun.file(path).text()) !== original) throw new Error(`Concurrent source edit: ${path}`);
    await Bun.write(path, source);
  }
}
