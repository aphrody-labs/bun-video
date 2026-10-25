import { join, resolve } from "node:path";

/** Ignored HyperFrames core sources that the runtime closure imports; each generator writes one atomically. */
export const hyperframesGenerated = [
  ["scripts/build-hyperframes-runtime-artifact.ts", "src/generated/runtime-inline.ts"],
  ["scripts/build-audio-fx-runtime.ts", "src/generated/audio-fx-runtime-inline.ts"],
  ["scripts/generate-font-data.ts", "src/fonts/fontData.generated.ts"],
] as const;

export async function generateHyperframes(root = resolve(import.meta.dir, ".."), force = false) {
  const core = join(root, "hyperframes/core");
  for (const [script, output] of hyperframesGenerated) {
    if (!force && (await Bun.file(join(core, output)).exists())) continue;
    const child = Bun.spawn([process.execPath, script], { cwd: core, stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${script} failed: ${stderr.trim()}`);
  }
}

if (import.meta.main) await generateHyperframes(undefined, Bun.argv.includes("--force"));
