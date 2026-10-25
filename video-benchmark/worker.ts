import { pathToFileURL } from "node:url";

const [project, root] = Bun.argv.slice(2);
if (!root || !["remotion", "hyperframes"].includes(project!)) throw new Error("worker <project> <root>");
const file = project === "hyperframes" ? "parsers/src/springEase.ts" : "core/src/interpolate.ts";
// Upstream baselines keep their workspace layout; the absorbed modules sit directly under the family root.
const upstream = `${root}/packages/${file}`;
const mod = await import(pathToFileURL((await Bun.file(upstream).exists()) ? upstream : `${root}/${file}`).href);
const iterations = Number(process.env.BUN_VIDEO_BENCH_ITERATIONS ?? 2000);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 200000)
  throw new RangeError("iterations must be 1..200000");
let checksum = 0;
const values: string[] = [];
const run = () => {
  for (let i = 0; i < iterations; i++) {
    if (project === "hyperframes") {
      const value: string = mod.generateSpringEaseData(1, 100 + (i % 5) * 40, [8, 20, 50][i % 3], 120);
      checksum += value.length;
      values.push(value);
    } else {
      const value: number = mod.interpolate(i % 301, [0, 150, 300], [0, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      checksum += value;
      values.push(String(value));
    }
  }
};
run();
checksum = 0;
values.length = 0;
const start = performance.now();
run();
const elapsedMs = performance.now() - start;
console.log(
  JSON.stringify({
    elapsedMs,
    checksum,
    digest: new Bun.CryptoHasher("sha256").update(JSON.stringify(values)).digest("hex"),
    rssBytes: process.memoryUsage().rss,
    iterations,
  }),
);
