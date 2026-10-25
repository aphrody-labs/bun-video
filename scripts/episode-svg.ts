#!/usr/bin/env bun
import { mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { rgbaToPixelSVG } from "../src/pixel-svg";
import { frameThemeFromRGBA } from "../src/frame-theme";

interface SourceCharacter {
  id: string;
  name: string;
  evidence: { timeSeconds: number }[];
}
interface Episode {
  id: string;
  title: string;
  width: number;
  height: number;
  fps: { numerator: number; denominator: number };
  source: { sha256: string };
  characters: SourceCharacter[];
  highlights: { id: string; title: string; start: number }[];
}
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pixelAPI(crop: boolean) {
  if (typeof Bun.Image.prototype.rgba !== "function" || (crop && typeof Bun.Image.prototype.extract !== "function"))
    throw new Error("A qualified Aphrody runtime with Bun.Image.rgba/extract is required; run through bun bd");
}

async function raw(path: string, width: number, height: number) {
  const pixels = await new Bun.Image(path, { maxPixels: width * height }).rgba();
  if (
    pixels.width !== width ||
    pixels.height !== height ||
    pixels.channels !== 4 ||
    pixels.data.byteLength !== width * height * 4
  )
    throw new Error("Native RGBA differs from the exact reference dimensions");
  return pixels.data;
}

export async function createEpisodeSVGs(episodeDir: string) {
  pixelAPI(true);
  const root = resolve(episodeDir),
    output = join(root, "icons/exact");
  await mkdir(output, { recursive: true });
  const episode: Episode = await Bun.file(join(root, "manifest.json")).json();
  const fps = episode.fps.numerator / episode.fps.denominator;
  const entries: Record<string, unknown>[] = [];
  const make = async (
    id: string,
    title: string,
    timeSeconds: number,
    crop: Rectangle | undefined,
    role: "reference-frame-svg" | "portrait-crop-svg" | "highlight-frame-svg",
  ) => {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Unsafe reference identifier: ${id}`);
    const frameNumber = Math.floor(timeSeconds * fps) + 1;
    const sourceFrame = `frames/frame-${String(frameNumber).padStart(6, "0")}.png`;
    const width = 256,
      height = crop
        ? Math.max(1, Math.round((256 * crop.height) / crop.width))
        : Math.round((256 * episode.height) / episode.width);
    if (height > 256) throw new Error("SVG reference exceeds the bounded 256 pixel grid");
    const png = `icons/exact/${id}.png`,
      svg = `icons/exact/${id}.svg`;
    const image = new Bun.Image(join(root, sourceFrame), {
      maxPixels: episode.width * episode.height,
    });
    if (crop) image.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    await image.resize(width, height).png().write(join(root, png));
    const pixels = await raw(join(root, png), width, height);
    const result = rgbaToPixelSVG(pixels, width, height, title);
    await Bun.write(join(root, svg), result.svg);
    entries.push({
      id,
      title,
      role,
      sourceFrame,
      timeSeconds,
      actualFrameTimeSeconds: (frameNumber - 1) / fps,
      frameNumber,
      crop: crop ?? { x: 0, y: 0, width: episode.width, height: episode.height },
      width,
      height,
      referencePNG: png,
      svg,
      sourceSha256: episode.source.sha256,
      colors: result.colors,
      runs: result.runs,
      svgBytes: Bun.file(join(root, svg)).size,
      resizeOwner: "Bun.Image",
      decodeOwner: "native Bun.Image.rgba",
      cropOwner: crop ? "native Bun.Image.extract" : undefined,
      vectorOwner: "bun-video rgbaToPixelSVG",
      paletteQuantized: false,
      embeddedRaster: false,
      verification: { status: "pending-browser-rgba-comparison" },
    });
  };
  for (const character of episode.characters) {
    const time = character.evidence[0]?.timeSeconds;
    if (typeof time !== "number") throw new Error(`No evidence frame for ${character.id}`);
    await make(
      `${character.id}-reference`,
      `${character.name} — frame de référence`,
      time,
      undefined,
      "reference-frame-svg",
    );
  }
  for (const highlight of episode.highlights)
    await make(`moment-${highlight.id}`, highlight.title, highlight.start, undefined, "highlight-frame-svg");
  await make(
    "beerus-portrait",
    "Beerus — visage recadré de l’anime",
    1025,
    { x: 600, y: 0, width: 840, height: 840 },
    "portrait-crop-svg",
  );
  await make(
    "whis-portrait",
    "Whis — visage recadré de l’anime",
    1140,
    { x: 210, y: 30, width: 840, height: 840 },
    "portrait-crop-svg",
  );
  const manifest = {
    schemaVersion: 1,
    episodeId: episode.id,
    method: "exact-solid-rgba-pixel-paths",
    maximumDimension: 256,
    artReference: "Dragon Ball Super anime frame; no claim of personal authorship by Akira Toriyama",
    qualification: "Exact SVG grid is the resized PNG reference, not the original 1920x1080 frame",
    entries,
  };
  const file = join(output, "manifest.json"),
    temporary = file + ".pending";
  await Bun.write(temporary, JSON.stringify(manifest, null, 2));
  try {
    await rename(temporary, file);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    await unlink(file);
    await rename(temporary, file);
  }
  return manifest;
}

export async function createHandoffThemes(episodeDir: string) {
  pixelAPI(false);
  const root = resolve(episodeDir),
    file = join(root, "handoff/shenron-visual.json");
  const handoff = await Bun.file(file).json();
  const tokensPath = Bun.resolveSync("@aphrody/m3-tokens/dynamic-color", import.meta.dir);
  const tokensVersion = (await Bun.file(tokensPath.replace(/src[\\/]dynamic-color\.ts$/, "package.json")).json())
    .version;
  await mkdir(join(root, "themes"), { recursive: true });
  const themes = [];
  for (const frame of handoff.frames) {
    const width = 64,
      height = Math.max(1, Math.round((width * frame.height) / frame.width));
    const sampleFile = `themes/handoff-frame-${String(frame.frameNumber).padStart(6, "0")}.png`;
    await new Bun.Image(frame.file, { maxPixels: frame.width * frame.height })
      .resize(width, height, { filter: "bilinear" })
      .png()
      .write(join(root, sampleFile));
    const pixels = await raw(join(root, sampleFile), width, height);
    const result = frameThemeFromRGBA(pixels, width, height, { dark: true, variant: "fidelity" });
    themes.push({
      frame: frame.file,
      frameNumber: frame.frameNumber,
      timecodeSeconds: frame.timecodeSeconds,
      requestedSeconds: frame.requestedSeconds,
      frameSha256: frame.sha256,
      ...result,
      variant: "fidelity",
      dark: true,
      tokensVersion,
      sampling: {
        owner: "Bun.Image",
        filter: "bilinear",
        width,
        height,
        decodeOwner: "native Bun.Image.rgba",
        file: sampleFile,
      },
      tokensOwner: "@aphrody/m3-tokens/dynamic-color",
    });
  }
  if (themes.length !== 6) throw new Error(`Shenron handoff requires six frames, received ${themes.length}`);
  handoff.themes = themes;
  handoff.themeApi.tokensVersion = tokensVersion;
  await Bun.write(file, JSON.stringify(handoff, null, 2));
  return {
    themes: themes.length,
    tokensVersion,
    frames: themes.map(item => item.frameNumber),
    seeds: themes.map(item => item.seed),
    roleCounts: themes.map(item => Object.keys(item.roles).length),
  };
}

if (import.meta.main) {
  if (Bun.argv[2] === "--handoff-themes") {
    console.log(
      JSON.stringify(
        await createHandoffThemes(Bun.argv[3] ?? resolve(import.meta.dir, "../.local/episodes/beerus-01")),
        null,
        2,
      ),
    );
  } else {
    const result = await createEpisodeSVGs(Bun.argv[2] ?? resolve(import.meta.dir, "../.local/episodes/beerus-01"));
    console.log(
      JSON.stringify({
        episodeId: result.episodeId,
        entries: result.entries.length,
        manifest: "icons/exact/manifest.json",
      }),
    );
  }
}
