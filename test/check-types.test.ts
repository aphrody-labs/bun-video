import { expect, test } from "bun:test";
import { ownedDiagnostics, parseDiagnostics } from "../scripts/check-types";

test("check-types keeps owned diagnostics and drops vendored trees", () => {
  const output = [
    "remotion/core/src/Img.tsx(131,13): error TS2540: Cannot assign to 'current'.",
    "hyperframes/cli/src/utils/harnessUsage.ts(7,17): error TS2307: Cannot find module 'ajv'.",
    "node_modules/.bun/x/y.tsx(1,1): error TS2322: nope",
    "src/playback.ts(10,2): error TS2304: Cannot find name 'x'.",
    "test/a.test.ts(3,4): error TS7006: Parameter implicitly has an 'any' type.",
    "  Try `bun add -d @types/minimist`",
  ].join("\n");
  const all = parseDiagnostics(output);
  expect(all).toHaveLength(5);
  expect(ownedDiagnostics(all).map(d => d.file)).toEqual(["src/playback.ts", "test/a.test.ts"]);
});
