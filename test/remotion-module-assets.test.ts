import { expect, test } from "bun:test";
import { rewriteIsolatedTypeExports, transpileRemotionBrowserSource } from "../remotion/.aphrody/module-assets";

test("browser materialization preserves environment branches for the final renderer bundle", () => {
  const source = "if (process.env.NODE_ENV !== 'production') { require('react-refresh/runtime'); }";
  const transformed = transpileRemotionBrowserSource(source, "ts", "setup-sequence-stack-traces.ts");
  const modules: string[] = [];
  const execute = new Function("process", "require", transformed);
  execute({ env: { NODE_ENV: "production" } }, (name: string) => modules.push(name));
  expect(modules).toEqual([]);
  execute({ env: { NODE_ENV: "development" } }, (name: string) => modules.push(name));
  expect(modules).toEqual(["react-refresh/runtime"]);
});

test("isolated Remotion assets erase referenced types while retaining runtime exports", async () => {
  const path = Bun.fileURLToPath(new URL("../remotion/media-utils/src/index.ts", import.meta.url));
  const source = rewriteIsolatedTypeExports(await Bun.file(path).text(), path);
  expect(source).toContain("type UseAudioDataOptions");
  expect(source).toContain("useAudioData");
  const result = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  expect(result).not.toContain("UseAudioDataOptions");
  expect(result).toContain("useAudioData");
  const licensingPath = Bun.fileURLToPath(new URL("../remotion/licensing/src/index.ts", import.meta.url));
  const alias = rewriteIsolatedTypeExports(
    "export {UsageEventClassification as Classification, registerUsageEvent} from './register-usage-event';",
    licensingPath,
  );
  expect(alias).toContain("type UsageEventClassification as Classification");
  expect(new Bun.Transpiler({ loader: "ts" }).transformSync(alias)).not.toContain("Classification");
  const pathsFile = Bun.fileURLToPath(new URL("../remotion/paths/src/index.ts", import.meta.url));
  const indirect = rewriteIsolatedTypeExports(await Bun.file(pathsFile).text(), pathsFile);
  expect(indirect).toContain("type WarpPathFn");
  expect(new Bun.Transpiler({ loader: "ts" }).transformSync(indirect)).not.toContain("WarpPathFn");
  const rendererFile = Bun.fileURLToPath(new URL("../remotion/renderer/src/index.ts", import.meta.url));
  const renderer = rewriteIsolatedTypeExports("export {AvailableOptions} from './options';", rendererFile);
  expect(renderer).toContain("type AvailableOptions");
  expect(new Bun.Transpiler({ loader: "ts" }).transformSync(renderer)).not.toContain("AvailableOptions");
});
