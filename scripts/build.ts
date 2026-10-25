import { mkdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  hyperframesDependencyPlugin,
  prepareHyperframesStandalone,
  hyperframesStandaloneConfig,
} from "../hyperframes/aphrody/standalone-build";
import { generateHyperframes } from "./generate-hyperframes";
import { remotionSourcePlugin } from "../remotion/.aphrody/standalone-build";
import { sharpNativePlugin } from "../hyperframes/aphrody/sharp-native-plugin";
import { remotionModuleAssetsPlugin } from "../remotion/.aphrody/module-assets";
import { mediaPlugin } from "./media-plugin";
import { videoCatalogPlugin } from "./catalog-plugin";
import { ytDlpAssetsPlugin } from "./ytdlp-assets-plugin";
import { hyperframesRuntimeAssetsPlugin } from "../hyperframes/aphrody/runtime-assets-plugin";
import { libraryReactPlugin, libraryWorkerPlugin, verifiedLibraryPlan } from "./library-plan";
import { assertLibraryOutputDirectory, ownedLibraryOutputs } from "./verify-library";
import { buildLibraryDeclarations } from "./library-declarations";
import { hostTargetInfo, SUPPORTED_TARGETS } from "@aphrody/bun-runtime-sdk/target";

const root = resolve(import.meta.dir, "..");
const library = Bun.argv[2] === "--library";
const outputArgument = Bun.argv[library ? 3 : 2];
const outfile = resolve(
  outputArgument && !outputArgument.startsWith("--")
    ? outputArgument
    : join(root, library ? "dist" : "../../tmp/bun-video-build/bun-video.exe"),
);
const plan = library ? await verifiedLibraryPlan(root) : undefined;
const nativeHost = library ? hostTargetInfo() : undefined;
const nativeAssetTarget = nativeHost
  ? Object.entries(SUPPORTED_TARGETS)
      .find(([, target]) => target === nativeHost.target)?.[0]
      .replace(/^win32-/, "windows-")
  : undefined;
if (library && !nativeAssetTarget) throw new Error("The installed SDK cannot identify this native asset host");
if (library && outfile !== join(root, "dist"))
  throw new Error("The published library must be built at its canonical package dist directory");
const refresh = library && Bun.argv.includes("--refresh");
if (library) await assertLibraryOutputDirectory(root, true);
const previous =
  library && (await Bun.file(join(outfile, "library-receipt.json")).exists())
    ? refresh
      ? await ownedLibraryOutputs(root)
      : (() => {
          throw new Error("A library receipt already exists; use --refresh after checking its owned outputs");
        })()
    : new Set<string>();
if (library && previous.size === 0) {
  await mkdir(outfile, { recursive: true });
  for await (const _name of new Bun.Glob("**/*").scan({ cwd: outfile, onlyFiles: false, followSymlinks: false }))
    throw new Error("An unowned output prevents a fresh library build");
}
await prepareHyperframesStandalone();
await generateHyperframes();
const declarations = library ? await buildLibraryDeclarations(root) : undefined;
const hyperframes = await hyperframesStandaloneConfig({
  outfile,
  entrypoint: join(root, "umbrella-src/cli.ts"),
});
const result = await Bun.build({
  ...hyperframes,
  entrypoints: plan
    ? plan.entries.map(source => resolve(root, source))
    : [join(root, "umbrella-src/cli.ts"), join(root, "src/frame-worker.ts"), join(root, "src/video-worker-entry.ts")],
  plugins: [
    ...(library ? [libraryReactPlugin()] : []),
    videoCatalogPlugin(),
    ytDlpAssetsPlugin(),
    await remotionSourcePlugin(),
    await sharpNativePlugin(),
    hyperframesRuntimeAssetsPlugin(),
    hyperframesDependencyPlugin(),
    await remotionModuleAssetsPlugin(
      library ? { libraryPackages: ["@remotion/cli", "@remotion/renderer", "remotion"] } : undefined,
    ),
    ...(library ? [libraryWorkerPlugin(root)] : []),
    ...(library ? [] : [mediaPlugin()]),
  ],
  ...(library
    ? {
        compile: undefined,
        outdir: outfile,
        root,
        splitting: true,
        naming: { entry: "[dir]/[name].ts", chunk: "chunks/[name]-[hash].js", asset: "assets/[name]-[hash].[ext]" },
        format: "esm" as const,
        metafile: true,
        external: [
          "bun-video:media-runtime",
          "@aphrody/bun-cloudflare/api",
          "@aphrody/m3-tokens",
          "@aphrody/m3-tokens/*",
          "react",
          "react/*",
          "react-dom",
          "react-dom/*",
        ],
      }
    : { external: ["@aphrody/bun-cloudflare/api"], compile: { outfile, executablePath: process.execPath } }),
});
if (!result.success) throw new AggregateError(result.logs, "Unified bun-video compilation failed");
if (plan) {
  for (const source of Object.values(plan.sourceBins)) {
    const output = resolve(root, plan.bins[Object.entries(plan.sourceBins).find(([, value]) => value === source)![0]]!);
    const contents = await Bun.file(output).text();
    if (!contents.startsWith("#!/usr/bin/env bun"))
      await Bun.write(output, "#!/usr/bin/env bun\n" + contents.replace(/^#![^\n]*\n/, ""));
  }
  const outputs = [];
  const outputHashes = new Map<string, string>();
  for (const artifact of result.outputs) {
    const name = relative(outfile, artifact.path).replaceAll("\\", "/");
    if (name.startsWith("..") || isAbsolute(name)) throw new Error("A library output escaped its dist directory");
    const bytes = await Bun.file(artifact.path).bytes();
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (outputHashes.has(name)) {
      if (outputHashes.get(name) !== sha256) throw new Error("Compiler returned conflicting output artifacts");
      continue;
    }
    outputHashes.set(name, sha256);
    outputs.push({ name, bytes: bytes.length, sha256 });
  }
  for (const output of plan.outputs) {
    if (!(await Bun.file(resolve(root, output)).exists())) throw new Error(`Missing compiled public entry: ${output}`);
  }
  for (const declaration of declarations?.declarations ?? []) {
    const name = "types/" + declaration.name;
    if (outputHashes.has(name)) throw new Error("Public declarations collide with a compiler output");
    const bytes = await Bun.file(declaration.path).bytes();
    if (
      bytes.length !== declaration.bytes ||
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== declaration.sha256
    )
      throw new Error("Public declaration stage changed before packaging");
    await Bun.write(join(outfile, name), bytes);
    outputHashes.set(name, declaration.sha256);
    outputs.push({ name, bytes: declaration.bytes, sha256: declaration.sha256 });
  }
  const inputs = [];
  const sourceNames = new Set([
    ...Object.keys(result.metafile?.inputs ?? {}),
    ...(declarations?.inputs ?? []),
    "bun.lock",
    "tsconfig.json",
    "tsconfig.check.json",
    "scripts/build.ts",
    "scripts/library-declarations.ts",
    "scripts/library-plan.ts",
    "scripts/catalog-plugin.ts",
    "scripts/ytdlp-assets-plugin.ts",
    "hyperframes/aphrody/standalone-build.ts",
    "hyperframes/aphrody/sharp-native-plugin.ts",
    "hyperframes/aphrody/runtime-assets-plugin.ts",
    "remotion/.aphrody/standalone-build.ts",
    "remotion/.aphrody/module-assets.ts",
    "remotion/.aphrody/module-assets-scope.ts",
    declarations!.sdkOwner.manifest,
    declarations!.sdkOwner.notice,
    declarations!.ambientOwner.manifest,
    ...Object.values(plan.manifest.patchedDependencies ?? {}),
  ]);
  const sdkNotice = await Bun.file(declarations!.sdkOwner.notice).bytes();
  const sdkNoticeName = "licenses/bun-runtime-sdk/LICENSE-APACHE";
  await Bun.write(join(outfile, sdkNoticeName), sdkNotice);
  outputHashes.set(sdkNoticeName, new Bun.CryptoHasher("sha256").update(sdkNotice).digest("hex"));
  outputs.push({ name: sdkNoticeName, bytes: sdkNotice.length, sha256: outputHashes.get(sdkNoticeName)! });
  const checkout = resolve(root, "../..");
  for (const path of new Set([...sourceNames].map(name => resolve(root, name)))) {
    if (!(await Bun.file(path).exists())) continue; // Plugin namespaces are recorded by the native metafile.
    // Store packages are pinned by the lock and their payload is already compiled; only checkout sources are receipt inputs.
    const member = relative(checkout, path);
    if (isAbsolute(member) || member.startsWith("..")) continue;
    const bytes = await Bun.file(path).bytes();
    inputs.push({
      name: relative(root, path).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
  }
  for (const name of previous) {
    if (!outputHashes.has(name)) await unlink(resolve(outfile, name));
  }
  const metafile = JSON.stringify(result.metafile);
  await Bun.write(
    join(outfile, "library-receipt.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        package: plan.manifest.name,
        version: plan.manifest.version,
        runtime: Bun.version,
        revision: Bun.revision,
        platform: process.platform,
        arch: process.arch,
        nativeAssetTarget,
        nativeHost,
        distributionQualified: false,
        entries: plan.entries,
        declarationTools: declarations?.tools,
        sdkOwner: {
          name: declarations!.sdkOwner.name,
          version: declarations!.sdkOwner.version,
          manifest: relative(root, declarations!.sdkOwner.manifest).replaceAll("\\", "/"),
          notice: sdkNoticeName,
        },
        ambientOwner: {
          name: declarations!.ambientOwner.name,
          version: declarations!.ambientOwner.version,
          source: relative(root, declarations!.ambientOwner.source).replaceAll("\\", "/"),
          payload: "types/ambient/dom-mediacapture-transform.d.ts",
        },
        declarationChanges: {
          packages: await Promise.all(
            Object.entries(plan.manifest.patchedDependencies ?? {}).map(async ([owner, patch]) => {
              const bytes = await Bun.file(join(root, patch)).bytes();
              const paths = [...new TextDecoder().decode(bytes).matchAll(/^diff --git a\/(\S+) b\/(\S+)\r?$/gm)];
              if (!paths.length || paths.some(path => path[1] !== path[2] || !path[1]!.endsWith(".d.ts")))
                throw new Error("Public declaration patch changes a runtime payload");
              return {
                owner,
                patch,
                files: paths.length,
                sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
                runtimeChanged: false,
              };
            }),
          ),
          source: [
            {
              path: "mediabunny/src/index.ts",
              removedReference: "dom-webcodecs",
              suppliedBy: "typescript@5.9.3/lib.dom.d.ts",
              retainedReference: "dom-mediacapture-transform",
            },
          ],
        },
        inputs,
        outputs,
        metafile: {
          sha256: new Bun.CryptoHasher("sha256").update(metafile).digest("hex"),
          inputCount: Object.keys(result.metafile?.inputs ?? {}).length,
          outputCount: Object.keys(result.metafile?.outputs ?? {}).length,
        },
        manifestSha256: new Bun.CryptoHasher("sha256")
          .update(await Bun.file(join(root, "package.json")).bytes())
          .digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
}
const artifact = await stat(library ? join(outfile, "src/index.ts") : outfile);
if (!artifact.isFile() || artifact.size === 0) throw new Error(`Compiler did not write executable ${outfile}`);
console.log(
  JSON.stringify({
    outfile,
    bytes: artifact.size,
    runtime: Bun.version,
    revision: Bun.revision,
    platform: process.platform,
    arch: process.arch,
  }),
);
