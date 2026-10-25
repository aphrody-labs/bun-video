import { resolve } from "node:path";
import type { BunPlugin } from "bun";

export async function ytDlpVendorAssets(root = resolve(import.meta.dir, "../yt-dlp")) {
  const entries: { path: string; absolute: string; bytes: number }[] = [];
  for await (const path of new Bun.Glob("yt_dlp/**/*").scan({ cwd: root, onlyFiles: true })) {
    const normalized = path.replaceAll("\\", "/");
    if (!normalized.startsWith("yt_dlp/") || normalized.split("/").includes(".."))
      throw new Error("Invalid vendored yt-dlp asset path");
    if (
      /(^|\/)(?:__pycache__|tests?|node_modules)(\/|$)/.test(normalized) ||
      !/\.(?:py|js|json|dat|bin|txt|pem)$/.test(normalized)
    )
      continue;
    const absolute = resolve(root, path);
    const bytes = Bun.file(absolute).size;
    if (bytes > 32 * 1024 * 1024) throw new Error("Vendored yt-dlp asset exceeds 32 MiB");
    entries.push({ path: normalized, absolute, bytes });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (
    !entries.some(entry => entry.path === "yt_dlp/__init__.py") ||
    !entries.some(entry => entry.path === "yt_dlp/version.py")
  )
    throw new Error("Canonical yt-dlp Python package absent");
  return entries;
}

/** Only the canonical package's runtime sources and shipped data enter the executable. */
export function ytDlpAssetsPlugin(): BunPlugin {
  return {
    name: "bun-video-ytdlp-vendor",
    setup(build) {
      build.onResolve({ filter: /^bun-video:ytdlp-vendor$/ }, () => ({ path: "vendor", namespace: "bun-video-ytdlp" }));
      build.onLoad({ filter: /.*/, namespace: "bun-video-ytdlp" }, async () => {
        const entries = await ytDlpVendorAssets();
        const imports = entries
          .map((entry, index) => `import asset${index} from ${JSON.stringify(entry.absolute)} with {type:'file'};`)
          .join("\n");
        const writes = entries
          .map(
            (entry, index) =>
              `writeFileSync(resolve(vendorRoot,${JSON.stringify(entry.path)}),readFileSync(asset${index}),{mode:0o600});`,
          )
          .join("\n");
        const directories = [...new Set(entries.map(entry => entry.path.slice(0, entry.path.lastIndexOf("/"))))];
        return {
          loader: "js",
          contents: `${imports}
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
const parent=resolve(tmpdir());
export const vendorRoot=mkdtempSync(join(parent,'bun-video-ytdlp-'));
const remove=()=>{const target=resolve(vendorRoot);if(dirname(target)!==parent||!basename(target).startsWith('bun-video-ytdlp-'))throw new Error('Invalid owned yt-dlp cleanup path');rmSync(target,{recursive:true,force:true});};
process.once('exit',remove);
try{${directories.map(path => `mkdirSync(resolve(vendorRoot,${JSON.stringify(path)}),{recursive:true});`).join("\n")}
${writes}}catch(error){remove();throw error;}
export const inventory={files:${entries.length},bytes:${entries.reduce((sum, entry) => sum + entry.bytes, 0)}};
`,
        };
      });
    },
  };
}
