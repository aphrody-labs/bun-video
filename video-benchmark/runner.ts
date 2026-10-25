import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const args = Bun.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const root = resolve(import.meta.dir, "../../..");
const monorepo = resolve(import.meta.dir, "..");
const samples = Number(option("--samples") ?? 7);
if (!Number.isInteger(samples) || samples < 3 || samples > 100) throw new Error("--samples must be 3..100");
const output = resolve(option("--out") ?? `${root}/tmp/video-benchmark/results.json`);
const projects = ["remotion", "hyperframes"] as const;
const results: Record<string, unknown> = {};
for (const project of projects) {
  const upstream = option(`--${project}-upstream`);
  if (!upstream) throw new Error(`Missing --${project}-upstream (checkout of pinned UPSTREAM.json revision)`);
  const baseline = resolve(upstream);
  const provenance = await Bun.file(`${monorepo}/${project}/UPSTREAM.json`).json();
  const sha = Bun.spawnSync(["git", "-C", baseline, "rev-parse", "HEAD"]);
  if (sha.exitCode !== 0) throw new Error(`Cannot resolve ${project} baseline revision`);
  const revision = sha.stdout.toString().trim();
  if (!JSON.stringify(provenance).includes(revision))
    throw new Error(`${project} baseline does not match pinned vendor revision`);
  const rows: Record<string, any[]> = { upstream: [], migrated: [] };
  for (let i = 0; i < samples; i++) {
    for (const variant of i % 2 ? ["migrated", "upstream"] : ["upstream", "migrated"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          `${import.meta.dir}/worker.ts`,
          project,
          variant === "upstream" ? baseline : `${monorepo}/${project}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${project}/${variant}: ${stderr}`);
      rows[variant].push(JSON.parse(stdout));
    }
  }
  const all = [...rows.upstream, ...rows.migrated];
  if (all.some(row => row.digest !== all[0].digest || row.checksum !== all[0].checksum))
    throw new Error(`${project}: upstream/migration output mismatch`);
  const stats = (rows: any[]) => {
    const timings = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
    return {
      medianMs: timings[Math.floor(timings.length / 2)],
      minMs: timings[0],
      maxMs: timings.at(-1),
      medianRssBytes: rows.map(row => row.rssBytes).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    };
  };
  const upstreamStats = stats(rows.upstream),
    migratedStats = stats(rows.migrated);
  results[project] = {
    revision,
    workload:
      project === "hyperframes"
        ? "generateSpringEaseData: under/critical/over damping, 120 samples"
        : "interpolate: three-point clamped triangle",
    rows,
    upstream: upstreamStats,
    migrated: migratedStats,
    upstreamOverMigrated: upstreamStats.medianMs / migratedStats.medianMs,
    parity: true,
  };
}
const fullStack = option("--aphrody-root")
  ? await import("./stack.ts").then(mod =>
      mod.measureStack(resolve(option("--aphrody-root")!), root, option("--native-library")),
    )
  : {
      status: "unmeasured",
      reason: "Pass --aphrody-root for the actual M3/Oxc/Obscura integration probe",
    };
await mkdir(resolve(output, ".."), { recursive: true });
const report = {
  measuredAt: new Date().toISOString(),
  runtime: {
    version: Bun.version,
    revision: Bun.revision,
    executable: process.execPath,
    platform: process.platform,
    arch: process.arch,
  },
  samples,
  scope:
    "Actual upstream and migrated core CPU functions on identical installed Aphrody Bun; excludes video encoding, browser render and startup",
  results,
  fullStack,
};
await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
