import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createUnifiedVideoPipeline } from "../src/video-workflow";
import { captureCompositionFrames } from "../src/render-frame";
import { openChromiumFrameContext } from "../src/chromium-frame";
import { compareRGBAFrames } from "../src/pixel-verify";
import { encodeFilmCraftFrames } from "../src/encode";
import { m3IconSVG, m3VideoDocument, prepareM3Video, rasterizeM3SVG, renderM3Video } from "../src/m3-video";
import {
  collection,
  type ShowcaseAsset,
  type ShowcaseEvidence,
  type ShowcaseManifest,
  type ShowcaseWork,
} from "../src/apps/site/collection";

const output = Bun.env.BUN_VIDEO_SHOWCASE_OUTPUT;
if (!output || !isAbsolute(output))
  throw new Error("Set an absolute BUN_VIDEO_SHOWCASE_OUTPUT on the build filesystem");
const directory = resolve(output);
await mkdir(directory, { recursive: true });
if (await Bun.file(join(directory, "showcase.json")).exists())
  throw new Error("Use a fresh versioned showcase directory");
const privateDirectory = Bun.env.BUN_VIDEO_SHOWCASE_PRIVATE;
if (!privateDirectory || !isAbsolute(privateDirectory))
  throw new Error("Set BUN_VIDEO_SHOWCASE_PRIVATE outside the public artifacts");
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
if (!relative(directory, await realpath(privateDirectory)).startsWith(".."))
  throw new Error("The private catalogue must be outside the public showcase");
await using pipeline = createUnifiedVideoPipeline({ dbPath: join(privateDirectory, "showcase.sqlite"), workers: 1 });
const manifest: ShowcaseManifest = {
  schema: "bun-video/showcase/v1",
  generatedAt: new Date().toISOString(),
  sourceRevision: Bun.env.BUN_VIDEO_SOURCE_REVISION ?? "uncommitted",
  runtime: { version: Bun.version, revision: Bun.revision, platform: process.platform },
  works: collection.map(work => ({ ...work, evidence: [] })),
  evidence: [],
  apis: [...pipeline.apis()],
};
const files = new Set<string>();
async function write(file: string, bytes: string | Uint8Array, mime: string): Promise<ShowcaseAsset> {
  if (!/^[a-zA-Z0-9/_.,-]+$/.test(file) || file.split("/").includes(".."))
    throw new Error("Unsafe public artifact path");
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  await Bun.write(join(directory, file), data);
  files.add(file);
  return { file, bytes: data.byteLength, sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"), mime };
}
async function evidence(
  id: string,
  scope: string,
  operation: () => Promise<Omit<ShowcaseEvidence, "id" | "scope" | "status">>,
) {
  let row: ShowcaseEvidence;
  try {
    row = { id, scope, status: "passed", ...(await operation()) };
  } catch (error) {
    console.error(error);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "OPERATION_FAILED";
    row = {
      id,
      scope,
      status: "failed",
      detail: `L’opération a échoué (${code}). Le diagnostic détaillé reste dans le journal privé.`,
      assets: [],
    };
  }
  manifest.evidence.push(row);
  pipeline.catalog.recordQualification({
    status: row.status === "unavailable" ? "blocked" : row.status,
    evidenceRef: `showcase:${id}`,
    detail: `${scope}: ${row.detail}`,
  });
  console.log(JSON.stringify({ id, status: row.status, assets: row.assets.length }));
  return row;
}
const html = (entry: string, title: string) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/${entry}.css"></head><body><div id="root"></div><script type="module" src="/${entry}.js"></script></body></html>`;
for (const entry of ["app", "preview"] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, `../src/apps/site/${entry}.tsx`)],
    target: "browser",
    minify: true,
    external: ["/fonts/*"],
    naming: { entry: "[name].[ext]", asset: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
  });
  if (!result.success) throw new AggregateError(result.logs, `Showcase ${entry} build failed`);
  for (const asset of result.outputs)
    await write(asset.path.split(/[\\/]/).at(-1)!, new Uint8Array(await asset.arrayBuffer()), asset.type);
  if (!files.has(`${entry}.css`))
    await write(
      `${entry}.css`,
      '@font-face{font-family:"Roboto Flex";src:url("/fonts/RobotoFlex-latin.woff2") format("woff2");font-style:normal;font-weight:100 1000;font-display:swap}html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}',
      "text/css",
    );
  await write(
    entry === "app" ? "index.html" : "preview.html",
    html(entry, entry === "app" ? "Aphrody Video — Bun Video Studio" : "Aphrody Video — Composition"),
    "text/html",
  );
}
for (const name of ["collection.ts", "artwork.tsx", "preview.tsx", "remotion.tsx"])
  await write(
    `sources/${name}`,
    await Bun.file(resolve(import.meta.dir, `../src/apps/site/${name}`)).bytes(),
    "text/plain",
  );
const fonts = dirname(Bun.fileURLToPath(import.meta.resolve("@aphrody/m3-fonts/fonts/RobotoFlex-OFL.txt")));
await write(
  "fonts/RobotoFlex-latin.woff2",
  await Bun.file(join(fonts, "web/RobotoFlex-latin.woff2")).bytes(),
  "font/woff2",
);
await write("fonts/OFL.txt", await Bun.file(join(fonts, "RobotoFlex-OFL.txt")).bytes(), "text/plain");
const source = Bun.env.BUN_VIDEO_SHOWCASE_SOURCE;
if (source) {
  const expected = Bun.env.BUN_VIDEO_SHOWCASE_SOURCE_SHA256;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Require the authorized episode's SHA-256");
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(source).stream()) hasher.update(chunk);
  if (hasher.digest("hex") !== expected) throw new Error("Episode source digest mismatch");
  const metadata = await new Bun.Video(source).metadata();
  await evidence("filmcraft-source", "authorized Shenron episode 876 metadata and source identity", async () => ({
    detail: "Épisode fourni vérifié par SHA-256. Métadonnées lues par Bun.Video.",
    assets: [
      await write(
        "proofs/source.json",
        JSON.stringify({ sha256: expected, decoder: Bun.Video.decoder, ...metadata }, null, 2),
        "application/json",
      ),
    ],
    measurements: {
      width: metadata.width,
      height: metadata.height,
      fpsNumerator: metadata.fpsNumerator,
      fpsDenominator: metadata.fpsDenominator,
      duration: metadata.duration,
      decoder: Bun.Video.decoder,
    },
  }));
  const transforms: Array<[string, string, (video: Bun.Video) => Bun.Video]> = [
    ["reference", "Image source", video => video],
    ["crop", "Recadrer le regard", video => video.extract({ left: 320, top: 180, width: 1280, height: 720 })],
    ["rotate", "Changer de perspective", video => video.rotate(90)],
    ["flip", "Miroir vertical", video => video.flip()],
    ["flop", "Miroir horizontal", video => video.flop()],
    ["vivid", "La couleur en scène", video => video.modulate({ saturation: 1.6, brightness: 1.08 })],
    ["mono", "En noir et lumière", video => video.modulate({ saturation: 0 })],
    ["thumbnail", "Une image, plusieurs usages", video => video.resize(320, 180, { fit: "inside" })],
  ];
  for (const [index, [id, title, transform]] of transforms.entries()) {
    const time = 48 + index * 12;
    const row = await evidence(
      `native-${id}`,
      "one selected episode frame and native image transformation",
      async () => {
        const frame = transform(new Bun.Video(source).frame(time)).resize(800, 450, { fit: "inside" });
        const encoded = await frame.webp({ quality: 90 }).bytes();
        const image = await new Bun.Image(encoded).metadata();
        const file = `native/${id}.webp`;
        const asset = await write(file, encoded, "image/webp");
        manifest.works.push({
          id: `native-${id}`,
          title,
          description: `Image extraite à ${time} secondes de l’épisode Shenron 876, transformée avec Bun.Video et Bun.Image.`,
          engine: id === "reference" ? "filmcraft" : "native",
          artwork: "terrain",
          features: ["Bun.Video", "Bun.Image", id],
          durationFrames: 1,
          fps: { num: metadata.fpsNumerator, den: metadata.fpsDenominator },
          width: image.width,
          height: image.height,
          preview: file,
          mediaType: "image",
          poster: file,
          evidence: [`native-${id}`],
        });
        return {
          detail: `${title} : résultat WebP décodé et dimensions contrôlées.`,
          assets: [asset],
          measurements: { sourceTimeSeconds: time, width: image.width, height: image.height, format: image.format },
        };
      },
    );
    if (row.status !== "passed") console.error(`Native transformation failed: ${id}`);
  }
  await evidence(
    "native-image-formats",
    "one source frame encoded and reopened in PNG, JPEG, WebP and AVIF",
    async () => {
      const assets: ShowcaseAsset[] = [];
      for (const format of ["png", "jpeg", "webp", "avif"] as const) {
        const video = new Bun.Video(source).frame(96).resize(640, 360);
        const bytes = await video[format]().bytes();
        const decoded = await new Bun.Image(bytes).rgba();
        if (decoded.width !== 640 || decoded.height !== 360) throw new Error(`Invalid ${format} output dimensions`);
        assets.push(await write(`native/formats/frame.${format}`, bytes, `image/${format}`));
      }
      return { detail: "Quatre formats d’image produits puis redécodés nativement.", assets };
    },
  );
  await evidence(
    "native-frame-batch",
    "six source-resolution PNG frames in one bounded native decode batch",
    async () => {
      const batch = await new Bun.Video(source).frames({ start: 60, end: 63, step: 0.5, maxFrames: 6 });
      if (batch.length !== 6) throw new Error("Incomplete native frame batch");
      const assets = [];
      for (const [index, frame] of batch.entries())
        assets.push(await write(`native/batch/frame-${index}.png`, frame.bytes, "image/png"));
      return {
        detail: "Six images pleine résolution dans un lot borné.",
        assets,
        measurements: { frames: batch.length, sourceTimes: batch.map(frame => frame.time) },
      };
    },
  );
  await evidence("native-audio", "three seconds of native decoded PCM WAV at 44100 Hz", async () => ({
    detail: "Fenêtre audio PCM de trois secondes extraite nativement.",
    assets: [
      await write(
        "native/audio.wav",
        await new Bun.Video(source).audio({ start: 60, duration: 3, sampleRate: 44100 }),
        "audio/wav",
      ),
    ],
  }));
  await evidence("native-gif", "two seconds, 12 FPS, 320px native GIF export", async () => {
    const bytes = await new Bun.Video(source).gif({ start: 60, duration: 2, fps: 12, width: 320 });
    const asset = await write("native/motion.gif", bytes, "image/gif");
    manifest.works.push({
      id: "native-motion",
      title: "Le mouvement en miniature",
      description: "Deux secondes de l’épisode, décodées et exportées en GIF par Bun.Video.",
      engine: "filmcraft",
      artwork: "wave",
      features: ["GIF", "native-decoder", "bounded-export"],
      durationFrames: 24,
      fps: { num: 12, den: 1 },
      width: 320,
      height: 180,
      preview: asset.file,
      mediaType: "image",
      poster: "native/reference.webp",
      evidence: ["native-gif"],
    });
    return { detail: "GIF réel de 24 images, sans exécutable média externe.", assets: [asset] };
  });
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const key = new URL(request.url).pathname.slice(1) || "index.html";
    if (!files.has(key)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(join(directory, key)));
  },
});
try {
  const browserPath = Bun.env.BUN_VIDEO_CHROMIUM ?? "/usr/bin/google-chrome";
  const sampleOnly = Bun.argv.includes("--sample-only");
  for (const work of manifest.works.filter(item => item.engine === "remotion" || item.engine === "hyperframes")) {
    const row = await evidence(
      `composition-${work.id}`,
      sampleOnly ? "seven sampled PNG frames; Chromium provider" : "every authored PNG frame; Chromium provider",
      async () => {
        const url = `http://127.0.0.1:${server.port}/preview.html?work=${work.id}`;
        await using browser = await openChromiumFrameContext({
          url,
          width: work.width,
          height: work.height,
          executable: browserPath,
          signal: AbortSignal.timeout(300000),
        });
        const assets: ShowcaseAsset[] = [];
        const frames = sampleOnly
          ? Array.from({ length: 7 }, (_, index) => Math.round((index * (work.durationFrames - 1)) / 6))
          : Array.from({ length: work.durationFrames }, (_, index) => index);
        for (const frame of frames) {
          for await (const captured of captureCompositionFrames(browser.context, {
            kind: work.engine as "remotion" | "hyperframes",
            compositionUrl: url,
            composition: work.id,
            fps: work.fps,
            startFrame: frame,
            endFrame: frame + 1,
            width: work.width,
            height: work.height,
            workers: 1,
          })) {
            const pixels = await new Bun.Image(captured.png).rgba();
            if (pixels.width !== work.width || pixels.height !== work.height)
              throw new Error("Captured dimensions do not match composition");
            assets.push(
              await write(`frames/${work.id}/${String(frame).padStart(4, "0")}.png`, captured.png, "image/png"),
            );
          }
        }
        const poster = assets.find(asset => asset.file.endsWith("0072.png")) ?? assets[0]!;
        work.poster = `posters/${work.id}.webp`;
        assets.push(
          await write(
            work.poster,
            await new Bun.Image(join(directory, poster.file)).resize(800, 450).webp({ quality: 88 }).bytes(),
            "image/webp",
          ),
        );
        work.frames = assets.filter(asset => asset.mime === "image/png").map(asset => asset.file);
        const nativeExecutable = Bun.env.BUN_VIDEO_NATIVE_EXECUTABLE;
        if (!sampleOnly && nativeExecutable) {
          const frameFiles = work.frames;
          async function* rgba() {
            for (const file of frameFiles) {
              const pixels = await new Bun.Image(join(directory, file)).rgba();
              yield { data: pixels.data, width: pixels.width, height: pixels.height };
            }
          }
          const videoFile = `videos/${work.id}.mp4`;
          await mkdir(join(directory, "videos"), { recursive: true });
          await encodeFilmCraftFrames(rgba(), {
            nativeExecutable,
            output: join(directory, videoFile),
            width: work.width,
            height: work.height,
            fps: work.fps,
            frames: work.durationFrames,
          });
          assets.push(await write(videoFile, await Bun.file(join(directory, videoFile)).bytes(), "video/mp4"));
          work.video = videoFile;
        }
        return {
          detail: `${frames.length} images capturées à ${work.fps.num}/${work.fps.den} i/s. Aucun encodage vidéo implicite.`,
          assets,
          measurements: {
            frames: frames.length,
            width: work.width,
            height: work.height,
            frameNumbers: frames,
            provider: "bun:chromium",
            engine: work.engine,
          },
        };
      },
    );
    work.evidence.push(row.id);
  }
  await evidence(
    "composition-visual-diversity",
    "five time samples per composition and six distinct scene signatures",
    async () => {
      const compositions = manifest.works.filter(
        work => (work.engine === "remotion" || work.engine === "hyperframes") && work.frames?.length,
      );
      const samples = [0, 24, 48, 72, 95];
      const signatures = new Map<string, string[]>();
      const measurements: Array<{ work: string; distinctTimeSamples: number; posterHash: string }> = [];
      for (const work of compositions) {
        const hashes: string[] = [];
        for (const frame of samples) {
          const path = work.frames![frame];
          if (!path) throw new Error(`Missing visual sample ${frame} for ${work.id}`);
          const pixels = await new Bun.Image(join(directory, path)).rgba();
          if (pixels.width !== work.width || pixels.height !== work.height || new Set(pixels.data).size < 8)
            throw new Error(`${work.id} has an empty or incorrectly sized visual sample`);
          hashes.push(new Bun.CryptoHasher("sha256").update(pixels.data).digest("hex"));
        }
        if (new Set(hashes).size < 3) throw new Error(`${work.id} does not visibly animate across its timeline`);
        measurements.push({ work: work.id, distinctTimeSamples: new Set(hashes).size, posterHash: hashes[3]! });
        if (work.engine === "remotion") signatures.set(work.artwork, hashes);
        else {
          const remotion = signatures.get(work.artwork);
          if (!remotion || remotion.some((hash, index) => hash !== hashes[index]))
            throw new Error(`Remotion and HyperFrames visual signatures differ for ${work.artwork}`);
        }
      }
      if (signatures.size !== 6 || new Set([...signatures.values()].map(hashes => hashes[3])).size !== 6)
        throw new Error("The six authored scenes must have distinct M3 visual signatures");
      const asset = await write(
        "proofs/visual-diversity.json",
        JSON.stringify(measurements, null, 2),
        "application/json",
      );
      return {
        detail:
          "Chaque animation change dans le temps; les six scènes et leurs deux moteurs sont visuellement distincts et déterministes.",
        assets: [asset],
        measurements: {
          compositions: compositions.length,
          uniqueScenes: signatures.size,
          samplesPerScene: samples.length,
        },
      };
    },
  );
  const m3Demos = await evidence(
    "m3-input-pipeline",
    "SVG logo, PNG, text and prompt composed into native Bun M3 videos",
    async () => {
      const dimensions = { width: 960, height: 540, frames: 96, fps: { num: 24, den: 1 } } as const;
      await using browser = await openChromiumFrameContext({
        url: `http://127.0.0.1:${server.port}/index.html`,
        width: dimensions.width,
        height: dimensions.height,
        executable: Bun.env.BUN_VIDEO_CHROMIUM ?? "/usr/bin/google-chrome",
        signal: AbortSignal.timeout(300000),
      });
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="58" fill="#f472b6"/><path d="M34 92V36h22q20 0 20 16 0 9-8 13 12 3 12 14 0 13-21 13z" fill="#17131a"/><path d="M48 48v12h9q7 0 7-6t-7-6zm0 23v9h11q7 0 7-5t-7-4z" fill="#fff"/></svg>',
      );
      const vectorPNG = await rasterizeM3SVG(svg, browser.context, { width: 512, height: 512 });
      const rasterLogo = vectorPNG;
      const inputs = [
        {
          id: "text",
          title: "Le code devient mouvement",
          input: { kind: "text" as const, text: "BUN VIDEO\nMATERIAL 3" },
          code: "prepareM3Video({ kind: 'text', text })",
        },
        {
          id: "prompt",
          title: "Une intention, une composition",
          input: { kind: "prompt" as const, text: "Une timeline plein écran, lumineuse et précise." },
          code: "prepareM3Video({ kind: 'prompt', text })",
        },
        {
          id: "png",
          title: "PNG, prêt pour la timeline",
          input: { kind: "image" as const, bytes: rasterLogo, format: "raster" as const, label: "Bun Video" },
          code: "new Bun.Image(bytes).resize(960, 540)",
        },
        {
          id: "logo",
          title: "Le logo devient une icône M3",
          input: { kind: "logo" as const, bytes: rasterLogo, format: "raster" as const, label: "Aphrody Video" },
          code: "m3IconSVG(await prepareM3Video({ kind: 'logo', bytes }))",
        },
      ];
      const assets: ShowcaseAsset[] = [];
      for (const demo of inputs) {
        const plan = await prepareM3Video(demo.input, { seed: "#e76f9b", dark: true, ...dimensions });
        const documentFile = `m3/${demo.id}.html`;
        await write(documentFile, m3VideoDocument(plan), "text/html; charset=utf-8");
        if (demo.id === "logo") assets.push(await write("m3/aphrody-video-icon.svg", m3IconSVG(plan), "image/svg+xml"));
        const compositionURL = `http://127.0.0.1:${server.port}/${documentFile}`;
        const videoFile = `videos/m3-${demo.id}.mp4`;
        await mkdir(join(directory, "videos"), { recursive: true });
        const posterFile = `posters/m3-${demo.id}.webp`;
        for await (const captured of captureCompositionFrames(browser.context, {
          kind: "hyperframes",
          compositionUrl: compositionURL,
          composition: `m3-${demo.id}`,
          fps: plan.fps,
          startFrame: 72,
          endFrame: 73,
          width: plan.width,
          height: plan.height,
          workers: 1,
        })) {
          assets.push(
            await write(posterFile, await new Bun.Image(captured.png).webp({ quality: 88 }).bytes(), "image/webp"),
          );
        }
        await renderM3Video(plan, {
          context: browser.context,
          compositionURL,
          engine: "hyperframes",
          composition: `m3-${demo.id}`,
          nativeExecutable: Bun.env.BUN_VIDEO_NATIVE_EXECUTABLE!,
          output: join(directory, videoFile),
        });
        files.delete(documentFile);
        const mp4 = await Bun.file(join(directory, videoFile)).bytes();
        assets.push(await write(videoFile, mp4, "video/mp4"));
        const work: ShowcaseWork & { poster?: string; evidence: string[] } = {
          id: `m3-${demo.id}`,
          title: demo.title,
          description: `Entrée ${demo.input.kind} normalisée avec Bun et composée selon les rôles Material 3 canoniques.`,
          engine: "filmcraft",
          artwork: "type",
          features: ["Bun.Video", "Bun.Image", "@aphrody/m3-tokens", "HyperFrames", "FilmCraft", demo.input.kind],
          durationFrames: plan.frames,
          fps: plan.fps,
          width: plan.width,
          height: plan.height,
          video: videoFile,
          poster: posterFile,
          chapter: "Entrées M3 · pipeline Bun",
          sourceRef: "packages/bun-video/src/m3-video.ts",
          code: demo.code,
          evidence: [],
        };
        const row = await evidence(
          `m3-${demo.id}`,
          "M3 video rendered through HyperFrames and the native FilmCraft encoder",
          async () => ({
            detail: `${plan.frames} images M3 rendues en H.264 par l’encodeur natif Bun Video.`,
            assets: assets.filter(asset => asset.file === videoFile || asset.file === "m3/aphrody-video-icon.svg"),
            measurements: {
              frames: plan.frames,
              fps: plan.fps,
              width: plan.width,
              height: plan.height,
              bytes: mp4.length,
            },
          }),
        );
        work.evidence = [row.id];
        manifest.works.push(work);
      }
      return { detail: "Quatre entrées concrètes livrées comme vidéos MP4 : texte, prompt, PNG et icône M3.", assets };
    },
  );
  if (m3Demos.status !== "passed") console.error("M3 input pipeline video generation failed");
  for (const remotion of manifest.works.filter(work => work.engine === "remotion" && work.frames?.length)) {
    const hyperframes = manifest.works.find(work => work.id === remotion.id.replace("remotion-", "hyperframes-"));
    if (!hyperframes?.frames?.length) continue;
    await evidence(
      `parity-${remotion.artwork}`,
      "decoded RGBA comparison of matching authored frames across both timelines",
      async () => {
        const measurements = [];
        const assets: ShowcaseAsset[] = [];
        for (const reference of remotion.frames!) {
          const candidate = hyperframes.frames!.find(file =>
            file.endsWith(reference.slice(reference.lastIndexOf("/"))),
          );
          if (!candidate) throw new Error("Missing counterpart for frame comparison");
          const a = await new Bun.Image(join(directory, reference)).rgba(),
            b = await new Bun.Image(join(directory, candidate)).rgba();
          measurements.push({
            frame: reference.split("/").at(-1),
            ...compareRGBAFrames(a.data, b.data, { width: a.width, height: a.height }),
          });
        }
        assets.push(
          await write(
            `proofs/parity-${remotion.artwork}.json`,
            JSON.stringify(measurements, null, 2),
            "application/json",
          ),
        );
        const exact = measurements.every(result => result.exact);
        return {
          detail: exact
            ? "Les images comparées sont identiques en RGBA, tolérance zéro."
            : "Des écarts RGBA ont été mesurés : consulter les erreurs par image.",
          assets,
          measurements: {
            exact,
            comparedFrames: measurements.length,
            maxChannelError: Math.max(...measurements.map(result => result.maxChannelError)),
          },
        };
      },
    );
  }
} finally {
  server.stop(true);
}
manifest.works = manifest.works.filter(work => Boolean(work.video));
for (const file of files) {
  if (/^(frames|native|proofs|m3|sources|preview(?:\.|\/))/.test(file) || file === "preview.html") files.delete(file);
}
manifest.works = manifest.works.map(work => ({ ...work, frames: undefined, preview: undefined, mediaType: undefined }));
manifest.evidence = manifest.evidence.map(row => ({
  ...row,
  assets: row.assets.filter(asset => files.has(asset.file)),
}));
await write("showcase.json", JSON.stringify(manifest, null, 2), "application/json");
await Bun.write(
  join(privateDirectory, "upload-plan.json"),
  JSON.stringify(
    {
      schema: "bun-video/showcase-upload/v1",
      bucket: "aphrody-video",
      origin: "https://video.aphrody.com",
      sourceRevision: manifest.sourceRevision,
      files: [...files].sort(),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output: directory,
    works: manifest.works.length,
    evidence: manifest.evidence.length,
    failed: manifest.evidence.filter(row => row.status === "failed").length,
  }),
);
if (manifest.evidence.some(row => row.status === "failed")) process.exitCode = 1;
