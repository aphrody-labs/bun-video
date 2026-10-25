import { resolve } from "node:path";
import {
  indexEpisodeAssets,
  packageEpisodeAssets,
  prepareEpisodeImages,
  writeEpisodeAssetIndex,
  type EpisodePackageManifest,
} from "../src/episode-assets";
import { unpackEpisodeAssets } from "../src/episode-unpack";

const [mode, rootArgument] = Bun.argv.slice(2);
const root = resolve(rootArgument ?? resolve(import.meta.dir, "../.local/episodes/beerus-01"));
if (!mode || mode === "--help")
  console.log(
    "bun scripts/episode-package.ts images|index|refresh|pack|unpack [episode-directory] [empty-output-directory]",
  );
else if (mode === "images") await prepareEpisodeImages(root);
else if (mode === "index") await writeEpisodeAssetIndex(root, await indexEpisodeAssets(root));
else if (mode === "refresh") {
  const previous = (await Bun.file(resolve(root, "package/manifest.json")).json()) as EpisodePackageManifest;
  await writeEpisodeAssetIndex(root, await indexEpisodeAssets(root, previous));
} else if (mode === "pack") {
  const input = (await Bun.file(resolve(root, "package/asset-index.json")).json()) as EpisodePackageManifest;
  if (input.producer !== "bun-video" || input.completeness.indexedFrames !== input.episode.frameCount)
    throw new Error("A fresh complete Bun Video index is required");
  await packageEpisodeAssets(root, input);
} else if (mode === "unpack") {
  const output = Bun.argv[4];
  if (!output) throw new Error("An explicit empty output directory is required");
  const input = (await Bun.file(resolve(root, "package/manifest.json")).json()) as EpisodePackageManifest;
  await unpackEpisodeAssets(root, resolve(output), input);
} else throw new Error("Expected images, index, refresh, pack or unpack");
