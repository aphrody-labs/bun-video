import { basename, dirname, isAbsolute, join } from "node:path";
import type { BunPlugin } from "bun";

const mediaDLL =
  /^(?:(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale|postproc|ass|fribidi|libplacebo)(?:-\d+)?|zlib1|z|bz2|freetype|harfbuzz|libpng16|brotlicommon|brotlidec|brotlienc|libgcc_s_seh-1|libstdc\+\+-6|libwinpthread-1|libssp-0|msvcr100|msvcp140|vcruntime140(?:_1)?)\.dll$/i;

/** PE import tables identify the adjacent DLLs the qualified executables actually load. */
export function windowsPEImports(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (bytes.length < 64 || u16(0) !== 0x5a4d) throw new Error("Media executable is not a Windows PE image");
  const pe = u32(0x3c);
  if (pe + 24 > bytes.length || u32(pe) !== 0x4550) throw new Error("Invalid media PE header");
  const optional = pe + 24;
  const magic = u16(optional);
  if (![0x10b, 0x20b].includes(magic)) throw new Error("Unsupported media PE optional header");
  const directory = optional + (magic === 0x20b ? 112 : 96);
  const sectionStart = optional + u16(pe + 20);
  const sectionCount = u16(pe + 6);
  const rvaOffset = (rva: number): number => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sectionStart + index * 40;
      const address = u32(section + 12),
        size = u32(section + 16);
      if (rva >= address && rva - address < size) return u32(section + 20) + rva - address;
    }
    throw new Error("Media PE import address is outside its file sections");
  };
  const result = new Set<string>();
  const addName = (rva: number) => {
    const start = rvaOffset(rva);
    let end = start;
    while (end < bytes.length && bytes[end] && end - start <= 255) end++;
    if (end >= bytes.length || end - start > 255) throw new Error("Invalid media PE import name");
    const name = new TextDecoder().decode(bytes.subarray(start, end));
    if (!name || name !== basename(name) || /[\\/]/.test(name)) throw new Error("Invalid media PE import filename");
    result.add(name.toLowerCase());
  };
  const importRva = u32(directory + 8);
  if (importRva) {
    for (let descriptor = rvaOffset(importRva), count = 0; count < 4096; descriptor += 20, count++) {
      const name = u32(descriptor + 12);
      if (!name) break;
      addName(name);
      if (count === 4095) throw new Error("Media PE import table exceeds its limit");
    }
  }
  const directoryCount = u32(optional + (magic === 0x20b ? 108 : 92));
  if (directoryCount > 13) {
    const delayedRva = u32(directory + 13 * 8);
    if (delayedRva)
      for (let descriptor = rvaOffset(delayedRva), count = 0; count < 4096; descriptor += 32, count++) {
        const name = u32(descriptor + 4);
        if (!name) break;
        if (!(u32(descriptor) & 1)) throw new Error("Media PE delay imports must use relative addresses");
        addName(name);
        if (count === 4095) throw new Error("Media PE delay import table exceeds its limit");
      }
  }
  return [...result].sort();
}

export async function windowsMediaDependencies(ffmpegExecutable: string, ffprobeExecutable: string): Promise<string[]> {
  const root = dirname(ffmpegExecutable);
  if (dirname(ffprobeExecutable).toLowerCase() !== root.toLowerCase())
    throw new Error("Windows FFmpeg and FFprobe must share their qualified DLL directory");
  const pending = [ffmpegExecutable, ffprobeExecutable];
  const seen = new Set<string>();
  const found = new Map<string, string>();
  while (pending.length) {
    const path = pending.shift()!;
    if (seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    if (Bun.file(path).size > 128 * 1024 * 1024) throw new Error("Media PE image exceeds 128 MiB");
    for (const name of windowsPEImports(await Bun.file(path).bytes())) {
      const adjacent = join(root, name);
      const exists = await Bun.file(adjacent).exists();
      if (!mediaDLL.test(name)) {
        if (exists) throw new Error(`Adjacent media dependency is outside the qualified DLL allowlist: ${name}`);
        continue; // Windows and driver libraries remain owned by the qualified host.
      }
      if (!exists) throw new Error(`Required adjacent FFmpeg dependency is missing: ${name}`);
      if (!found.has(name)) {
        found.set(name, adjacent);
        pending.push(adjacent);
      }
    }
  }
  return [...found.values()].sort();
}

export function mediaPlugin(): BunPlugin {
  return {
    name: "bun-video-native-media",
    setup(build) {
      build.onResolve({ filter: /^bun-video:media-runtime$/ }, () => ({
        path: "media",
        namespace: "bun-video-media",
      }));
      build.onLoad({ filter: /.*/, namespace: "bun-video-media" }, async () => {
        const assets = {
          nativeExecutable: process.env.BUN_VIDEO_NATIVE_EXECUTABLE,
          ffmpegExecutable: process.env.BUN_VIDEO_FFMPEG,
          ffprobeExecutable: process.env.BUN_VIDEO_FFPROBE,
        };
        for (const [name, path] of Object.entries(assets))
          if (!path || !isAbsolute(path) || !(await Bun.file(path).exists()))
            throw new Error(`Set ${name} to an existing qualified absolute media asset before compilation`);
        const extension = process.platform === "win32" ? ".exe" : "";
        const entries = Object.entries(assets);
        const dependencies =
          process.platform === "win32"
            ? await windowsMediaDependencies(assets.ffmpegExecutable!, assets.ffprobeExecutable!)
            : [];
        const imports = [...entries.map(([, path]) => path!), ...dependencies]
          .map((path, i) => `import asset${i} from ${JSON.stringify(path)} with {type:'file'};`)
          .join("\n");
        const dependencyWrites = dependencies
          .map(
            (path, index) =>
              `writeFileSync(join(dir,${JSON.stringify(basename(path))}),readFileSync(asset${index + entries.length}),{mode:0o700});`,
          )
          .join("\n");
        const writes = entries
          .map(
            ([name], i) =>
              `const ${name}=join(dir,${JSON.stringify(name + extension)});writeFileSync(${name},readFileSync(asset${i}),{mode:0o700});`,
          )
          .join("\n");
        return {
          loader: "js",
          contents: `${imports}\nimport {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';const dir=mkdtempSync(join(tmpdir(),'bun-video-media-'));process.once('exit',()=>rmSync(dir,{recursive:true}));${writes}${dependencyWrites}\nexport const mediaAssets={nativeExecutable,ffmpegExecutable,ffprobeExecutable};`,
        };
      });
    },
  };
}
