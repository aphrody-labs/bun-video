import { fileURLToPath } from "node:url";
const src = fileURLToPath(new URL("../../hyperframes/cli/src/commands/__fixtures__/silent.mp4", import.meta.url));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time(label: string, n: number, fn: () => Promise<unknown>) {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  return { label, n, medianMs: +median(samples).toFixed(2), minMs: +Math.min(...samples).toFixed(2), maxMs: +Math.max(...samples).toFixed(2) };
}
const results = [];
results.push(await time("video.metadata", 15, () => new Bun.Video(src).metadata()));
results.push(await time("video.frame.webp.320", 15, () => new Bun.Video(src).frame(0.5).resize(320, 180).webp({ quality: 80 }).bytes()));
results.push(await time("video.frame.rgba", 15, () => new Bun.Video(src).frame(0.5).resize(128, 96).rgba()));
results.push(await time("video.frames.batch4", 8, () => new Bun.Video(src).frames({ start: 0, end: 0.5, step: 0.125, maxFrames: 4 })));
const png = await new Bun.Video(src).frame(0.5).resize(320, 180).png().bytes();
results.push(await time("image.png.reencode", 15, () => new Bun.Image(png).resize(160, 90).webp({ quality: 80 }).bytes()));
results.push(await time("image.jpeg.encode", 15, () => new Bun.Image(png).jpeg({ quality: 85 }).bytes()));
console.log(JSON.stringify(results, null, 1));
await Bun.write("bench-results.json", JSON.stringify({ source: src, runtime: Bun.version, revision: Bun.revision, results }, null, 2));
