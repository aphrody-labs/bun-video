import { mkdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import manifest from "./sdk-manifest.json";
import { mediaSDKHostTarget, type MediaSDKTarget } from "./sdk-platform";

export type MediaSDKComponent = "ffmpeg" | "mpv";
export type { MediaSDKTarget } from "./sdk-platform";
export interface MediaSDKAsset {
  url: string;
  sha256: string;
  bytes: number;
  format: string;
}
export interface MediaSDKDescriptor {
  version?: string;
  sourceRevision?: string;
  sourceRepository?: string;
  license?: string;
  status: string;
  assets: MediaSDKAsset[];
  upstreamAssets?: MediaSDKAsset[];
  apiMajor?: number;
  libraryName?: string;
  buildRecipe?: {
    owner: string;
    sourcePins: string;
    dependencies: string[];
    status: string;
    nativeSidecar?: { owner: string; features: string[]; gpuQualification: string };
    profile?: string;
  };
}

export function mediaSDKPrefix(component: MediaSDKComponent, executable = process.execPath): string {
  if (!isAbsolute(executable)) throw new TypeError("Bun executable path must be absolute");
  const target = mediaSDKHostTarget();
  mediaSDKPlan(component, target);
  return join(dirname(executable), "lib/media", component, target);
}

export function mediaSDKLibraryDirectory(component: MediaSDKComponent, directory?: string): string {
  const explicit = directory ?? Bun.env.BUN_VIDEO_MEDIA_DIR;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new TypeError("Media library directory must be absolute");
    return explicit;
  }
  return join(mediaSDKPrefix(component), process.platform === "win32" ? "bin" : "lib");
}

export function mediaSDKPlan(component: MediaSDKComponent, target: MediaSDKTarget): MediaSDKDescriptor {
  if (!Object.hasOwn(manifest.targets, target) || !["ffmpeg", "mpv"].includes(component))
    throw new TypeError("Unsupported media SDK target or component");
  const plan = structuredClone(manifest.targets[target][component]);
  if (
    "libraryName" in plan &&
    (typeof plan.libraryName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(plan.libraryName))
  )
    throw new TypeError("SDK library name must be a file basename");
  return { ...plan, buildRecipe: structuredClone(manifest.buildRecipes[component]) };
}

export function validateSDKAsset(asset: MediaSDKAsset): void {
  const url = new URL(asset.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new TypeError("SDK assets require an unsigned HTTPS source URL");
  if (
    !["zip", "tar.xz", "tar.gz"].includes(asset.format) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > 512 * 1024 * 1024
  )
    throw new TypeError("SDK assets require a pinned SHA-256 and bounded exact size");
}

export async function hashSDKFile(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new TypeError("SDK file path must be absolute");
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadMediaSDK(
  component: MediaSDKComponent,
  target: MediaSDKTarget,
  cache: string,
  signal?: AbortSignal,
  upstream = false,
): Promise<string[]> {
  if (!isAbsolute(cache)) throw new TypeError("SDK cache directory must be absolute");
  const plan = mediaSDKPlan(component, target);
  const assets = upstream ? (plan.upstreamAssets ?? []) : plan.assets;
  if (!assets.length)
    throw new Error(`No ${upstream ? "upstream" : "normalized distribution"} ${component} SDK is pinned for ${target}`);
  await mkdir(cache, { recursive: true });
  const files: string[] = [];
  for (const asset of assets) {
    validateSDKAsset(asset);
    signal?.throwIfAborted();
    const destination = join(cache, `${asset.sha256}.${asset.format}`);
    if (await Bun.file(destination).exists()) {
      if ((await stat(destination)).size !== asset.bytes || (await hashSDKFile(destination)) !== asset.sha256)
        throw new Error("Cached media SDK does not match its pinned identity");
      files.push(destination);
      continue;
    }
    const timeout = AbortSignal.timeout(300_000);
    const response = await fetch(asset.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !response.body) throw new Error(`Media SDK download failed (${response.status})`);
    const temporary = `${destination}.part-${crypto.randomUUID()}`;
    const writer = Bun.file(temporary).writer();
    const hash = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    let ended = false;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > asset.bytes) throw new Error("Media SDK download exceeded its pinned size");
        hash.update(chunk);
        writer.write(chunk);
        await writer.flush();
      }
      ended = true;
      await writer.end();
      if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
        throw new Error("Media SDK download failed SHA-256 or exact-size verification");
      await rename(temporary, destination);
      files.push(destination);
    } finally {
      try {
        if (!ended) await writer.end();
      } finally {
        if (await Bun.file(temporary).exists()) await unlink(temporary);
      }
    }
  }
  return files;
}

export async function runMediaSDKCommand(component: MediaSDKComponent, root: string): Promise<boolean> {
  const action = process.argv[2] ?? "sdk-plan";
  if (!action?.startsWith("sdk-")) return false;
  const target = (Bun.env.BUN_MEDIA_TARGET ?? mediaSDKHostTarget()) as MediaSDKTarget;
  const plan = mediaSDKPlan(component, target);
  if (action === "sdk-plan") console.log(JSON.stringify({ target, component, ...plan }, null, 2));
  else if (action === "sdk-download" || action === "sdk-upstream-download") {
    const cache = resolve(Bun.env.BUN_MEDIA_CACHE ?? join(root, "build/media-sdk/cache"));
    console.log(
      JSON.stringify(
        {
          target,
          component,
          files: await downloadMediaSDK(component, target, cache, undefined, action === "sdk-upstream-download"),
        },
        null,
        2,
      ),
    );
  } else if (action === "sdk-extract") {
    const archive = process.argv[3];
    const destination = process.argv[4];
    if (!archive || !destination)
      throw new TypeError("sdk-extract requires an archive and empty destination directory");
    const absoluteArchive = resolve(archive);
    const identity = await hashSDKFile(absoluteArchive);
    const asset = plan.assets.find(asset => asset.sha256 === identity);
    if (!asset || (await stat(absoluteArchive)).size !== asset.bytes)
      throw new Error("SDK archive is not a pinned asset");
    await mkdir(resolve(destination), { recursive: false });
    await extractMediaSDKArchive(absoluteArchive, resolve(destination));
  } else if (action === "sdk-verify") {
    const prefix = process.argv[3] ?? Bun.env.BUN_MEDIA_PREFIX;
    if (!prefix) throw new TypeError("sdk-verify requires an explicit SDK prefix");
    console.log(JSON.stringify(await verifyMediaSDKLayout(component, target, resolve(prefix)), null, 2));
  } else throw new TypeError("Expected sdk-plan|sdk-download|sdk-upstream-download|sdk-extract|sdk-verify");
  return true;
}

async function confinedFile(prefix: string, path: string): Promise<string> {
  const base = await realpath(prefix);
  const actual = await realpath(path);
  const within = relative(base, actual);
  if (!within || within.startsWith("..") || isAbsolute(within))
    throw new Error("SDK member escaped its selected directory");
  if (!(await stat(actual)).isFile()) throw new Error("SDK member must be a regular file");
  return actual;
}

export async function verifyMediaSDKLayout(component: MediaSDKComponent, target: MediaSDKTarget, prefix: string) {
  if (!isAbsolute(prefix)) throw new TypeError("SDK prefix must be absolute");
  const plan = mediaSDKPlan(component, target);
  if (!plan.sourceRevision) throw new Error(`No source revision is pinned for ${component} on ${target}`);
  const files: string[] = [];
  if (component === "ffmpeg") {
    for (const [library, major] of Object.entries(manifest.ffmpegABI)) {
      const includeDirectory = `lib${library}`;
      const candidates = [
        join(prefix, "include", includeDirectory, "version_major.h"),
        join(prefix, "include", includeDirectory, "version.h"),
      ] as const;
      const header = (await Bun.file(candidates[0]).exists()) ? candidates[0] : candidates[1];
      const source = Bun.file(await confinedFile(prefix, header));
      if (source.size > 1024 * 1024) throw new Error("SDK header exceeded its size bound");
      const version = (await source.text()).match(
        new RegExp(`#\\s*define\\s+LIB${library.toUpperCase()}_VERSION_MAJOR\\s+(\\d+)`),
      );
      if (!version || Number(version[1]) !== major) throw new Error(`FFmpeg ${library} SDK header ABI mismatch`);
      files.push(header);
      const libraryFile = target.startsWith("windows")
        ? join(prefix, "bin", `${library}-${major}.dll`)
        : target.startsWith("darwin")
          ? join(prefix, "lib", `lib${library}.${major}.dylib`)
          : join(prefix, "lib", `lib${library}.so.${major}`);
      files.push(await confinedFile(prefix, libraryFile));
      if (target.startsWith("windows")) {
        const imports = [join(prefix, "lib", `${library}.lib`), join(prefix, "lib", `lib${library}.dll.a`)] as const;
        const found = (await Bun.file(imports[0]).exists()) ? imports[0] : imports[1];
        files.push(await confinedFile(prefix, found));
      }
    }
    for (const executable of ["ffmpeg", "ffprobe"]) {
      files.push(
        await confinedFile(prefix, join(prefix, "bin", executable + (target.startsWith("windows") ? ".exe" : ""))),
      );
    }
  } else {
    const header = await confinedFile(prefix, join(prefix, "include/mpv/client.h"));
    if (
      Bun.file(header).size > 1024 * 1024 ||
      !(await Bun.file(header).text()).match(/MPV_CLIENT_API_VERSION\s+MPV_MAKE_VERSION\(\s*2\s*,/)
    )
      throw new Error("mpv client SDK header ABI mismatch");
    files.push(header);
    files.push(
      await confinedFile(
        prefix,
        join(
          prefix,
          target.startsWith("windows") ? "bin" : "lib",
          plan.libraryName ?? (target.startsWith("windows") ? "libmpv-2.dll" : "libmpv.so.2"),
        ),
      ),
    );
    files.push(await confinedFile(prefix, join(prefix, target.startsWith("windows") ? "bin/mpv.exe" : "bin/mpv")));
    if (target.startsWith("windows")) {
      const imports = [join(prefix, "lib/mpv.lib"), join(prefix, "lib/libmpv.dll.a")] as const;
      files.push(await confinedFile(prefix, (await Bun.file(imports[0]).exists()) ? imports[0] : imports[1]));
    }
  }
  const licenses: string[] = [];
  for await (const name of new Bun.Glob("**/{COPYING,LICENSE,Copyright,licenses}/**").scan({
    cwd: prefix,
    onlyFiles: true,
  }))
    licenses.push(name);
  for await (const name of new Bun.Glob("**/{COPYING*,LICENSE*,Copyright*}").scan({ cwd: prefix, onlyFiles: true }))
    licenses.push(name);
  if (!licenses.length) throw new Error("A complete SDK must retain its license notices");
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async path => [relative(prefix, path).replaceAll("\\", "/"), await hashSDKFile(resolve(path))]),
    ),
  );
  return {
    schema: 1,
    component,
    target,
    version: plan.version,
    sourceRevision: plan.sourceRevision,
    qualification: "headers-and-file-layout-only",
    files: hashes,
    licenses: [...new Set(licenses)],
  };
}

export async function extractMediaSDKArchive(file: string, directory: string): Promise<number> {
  if (!isAbsolute(file) || !isAbsolute(directory)) throw new TypeError("SDK extraction paths must be absolute");
  const magic = new Uint8Array(await Bun.file(file).slice(0, 4).arrayBuffer());
  if (magic[0] !== 0x50 || magic[1] !== 0x4b || magic[2] !== 0x03 || magic[3] !== 0x04)
    throw new Error("SDK consumers require a normalized ZIP; upstream archives must be normalized by the factory");
  await mkdir(dirname(directory), { recursive: true });
  const archive = new Bun.Archive(await Bun.file(file).bytes());
  const members = await archive.files();
  let expanded = 0;
  for (const [name, value] of members) {
    const normalized = name.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").some(part => part === "..") ||
      /^[A-Za-z]:/.test(normalized)
    )
      throw new Error("Media SDK archive contains an unsafe member path");
    expanded += value.size;
    if (expanded > 2 * 1024 * 1024 * 1024 || members.size > 100000)
      throw new Error("Media SDK expanded size or entry count exceeded its bound");
  }
  return archive.extract(directory);
}
