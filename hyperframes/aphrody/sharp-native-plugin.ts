import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readdir } from "node:fs/promises";

export interface NativeCompositionTarget {
  sharpPlatform: string;
  compositorPackage: string;
  compileTarget: string;
  executableSuffix: string;
}

export function nativeCompositionTarget(
  platform: string,
  arch: string,
  libc?: string,
): NativeCompositionTarget {
  if (platform === "win32" && arch === "x64") {
    return {
      sharpPlatform: "win32-x64",
      compositorPackage: "@remotion/compositor-win32-x64-msvc",
      compileTarget: "bun-windows-x64",
      executableSuffix: ".exe",
    };
  }
  if (
    platform === "linux" &&
    ["x64", "arm64"].includes(arch) &&
    ["glibc", "musl"].includes(libc ?? "")
  ) {
    return {
      sharpPlatform: `linux${libc === "musl" ? "musl" : ""}-${arch}`,
      compositorPackage: `@remotion/compositor-linux-${arch}-${libc === "musl" ? "musl" : "gnu"}`,
      compileTarget: `bun-linux-${arch}${libc === "musl" ? "-musl" : ""}`,
      executableSuffix: "",
    };
  }
  throw new Error(
    `Native composition assets are unsupported for ${platform}/${arch}/${libc ?? "unknown-libc"}`,
  );
}

function sharpRequire() {
  const cliRequire = createRequire(join(import.meta.dir, "../cli/src/cli.ts"));
  return createRequire(cliRequire.resolve("sharp"));
}

export function resolveNativeCompositionTarget(): NativeCompositionTarget {
  const libc: { familySync(): string | null } = sharpRequire()("detect-libc");
  return nativeCompositionTarget(
    process.platform,
    process.arch,
    process.platform === "linux" ? (libc.familySync() ?? undefined) : undefined,
  );
}

interface Asset {
  path: string;
  relative: string;
}

export async function sharpNativePlugin(): Promise<Bun.BunPlugin> {
  const target = resolveNativeCompositionTarget();
  const require = sharpRequire();
  const bindingExport = require.resolve(`@img/sharp-${target.sharpPlatform}/sharp.node`);
  const directory = bindingExport.endsWith(".node")
    ? dirname(bindingExport)
    : join(dirname(bindingExport), "lib");
  const names = (await readdir(directory)).filter((name) => /\.(?:node|dll)$/.test(name));
  const bindings = names.filter((name) => name.endsWith(".node"));
  if (
    bindings.length !== 1 ||
    (process.platform === "win32" && !names.some((name) => name.endsWith(".dll")))
  ) {
    throw new Error(
      "Sharp addon directory is missing an unambiguous native binding or platform libraries",
    );
  }
  const binding = join(`sharp-${target.sharpPlatform}`, "lib", bindings[0]!);
  const assets: Asset[] = names.map((name) => ({
    path: join(directory, name),
    relative: join(`sharp-${target.sharpPlatform}`, "lib", name),
  }));
  if (process.platform === "linux") {
    const libraryManifest = require.resolve(`@img/sharp-libvips-${target.sharpPlatform}/package`);
    const libraryDirectory = join(dirname(libraryManifest), "lib");
    const libraries = (await readdir(libraryDirectory)).filter((name) =>
      /\.so(?:\.\d+)*$/.test(name),
    );
    if (!libraries.some((name) => name.startsWith("libvips-cpp.so")))
      throw new Error("Sharp Linux libvips shared library is absent");
    for (const name of libraries)
      assets.push({
        path: join(libraryDirectory, name),
        relative: join(`sharp-libvips-${target.sharpPlatform}`, "lib", name),
      });
  }
  if (assets.length > 64) throw new Error("Sharp native asset inventory exceeds its bound");
  return {
    name: "hyperframes-sharp-native-assets",
    setup(build) {
      build.onLoad({ filter: /[\\/]sharp[\\/](?:dist|lib)[\\/]sharp\.[cm]?js$/ }, (args) => {
        const imports = assets
          .map(
            (asset, index) =>
              `import asset${index} from ${JSON.stringify(asset.path)} with {type:"file"};`,
          )
          .join("\n");
        const writes = assets
          .map(
            (asset, index) =>
              `mkdirSync(dirname(join(nativeDir,${JSON.stringify(asset.relative)})),{recursive:true,mode:0o700});writeFileSync(join(nativeDir,${JSON.stringify(asset.relative)}),readFileSync(asset${index}),{mode:0o600});`,
          )
          .join("\n");
        return {
          loader: "js",
          contents: `${imports}
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {createRequire} from "node:module";
const nativeDir=mkdtempSync(join(tmpdir(),"bun-video-sharp-"));
let binding;
try {
${writes}
binding=createRequire(import.meta.url)(join(nativeDir,${JSON.stringify(binding)}));
${["linux-x64", "linuxmusl-x64"].includes(target.sharpPlatform) ? 'if(typeof binding._isUsingX64V2==="function"&&!binding._isUsingX64V2())throw Error("Sharp prebuilt Linux x64 requires x86-64-v2");' : ""}
} catch(error) {
rmSync(nativeDir,{recursive:true,force:true});
throw error;
}
process.once("exit",()=>{try{rmSync(nativeDir,{recursive:true,force:true});}catch{}});
${args.path.endsWith(".mjs") ? "export default binding;" : "module.exports=binding;"}
`,
        };
      });
    },
  };
}
