import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyNativeVideos, hashEpisodeFile } from "./episode-assets";

type Manifest = {
  source: { file: string; sha256?: string };
  width?: number;
  height?: number;
  frameCount?: number;
  fps?: { numerator: number; denominator: number };
  video?: { width: number; height: number; fps: { num: number; den: number }; frameCount: number };
};
function options(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1] || args[index + 1]!.startsWith("--"))
      throw new Error("Expected --option value");
    if (!["--episode-dir", "--output", "--timeout-ms"].includes(args[index]!))
      throw new Error(`Unknown native replay option: ${args[index]}`);
    values.set(args[index]!, args[index + 1]!);
  }
  return values;
}
async function main() {
  const [mode, ...args] = Bun.argv.slice(2);
  if (!mode || mode === "--help") {
    console.log(
      "bun plugin/skills/video-pixel-perfect/scripts/episode-replay.ts replay|verify --episode-dir PATH [--output PATH.mp4] [--timeout-ms 14400000]",
    );
    return;
  }
  if (mode !== "replay" && mode !== "verify") throw new Error("Expected replay or verify");
  const opts = options(args),
    dirArg = opts.get("--episode-dir");
  if (!dirArg) throw new Error("--episode-dir is required");
  const dir = resolve(dirArg),
    manifest: Manifest = await Bun.file(join(dir, "manifest.json")).json();
  if (!manifest.source?.file) throw new Error("Missing encoded source in episode manifest");
  const source = resolve(dir, manifest.source.file),
    output = resolve(opts.get("--output") ?? join(dir, "episode-replay.mp4"));
  if (output.toLowerCase() === source.toLowerCase() || !output.toLowerCase().endsWith(".mp4"))
    throw new Error("Select a separate native MP4 preservation output");
  const timeoutMs = Number(opts.get("--timeout-ms") ?? 14400000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000)
    throw new Error("Invalid operation deadline");
  const signal = AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  if (typeof Bun.Video !== "function" || !Bun.Video.available)
    throw new Error("A qualified native Bun.Video runtime is required; use bun bd");
  const metadata = await new Bun.Video(source).metadata();
  const width = manifest.width ?? manifest.video?.width,
    height = manifest.height ?? manifest.video?.height;
  const count = manifest.frameCount ?? manifest.video?.frameCount;
  const fps =
    manifest.fps ??
    (manifest.video ? { numerator: manifest.video.fps.num, denominator: manifest.video.fps.den } : undefined);
  if (
    metadata.width !== width ||
    metadata.height !== height ||
    metadata.frameCount !== count ||
    !fps ||
    metadata.fpsNumerator * fps.denominator !== fps.numerator * metadata.fpsDenominator
  )
    throw new Error("Encoded source differs from declared resolution, frame count or rational cadence");
  if (manifest.source.sha256 && (await hashEpisodeFile(source)) !== manifest.source.sha256)
    throw new Error("Encoded source SHA-256 changed");
  if (mode === "replay") {
    if (await Bun.file(output).exists()) throw new Error("Preservation output already exists");
    await mkdir(dirname(output), { recursive: true });
    signal.throwIfAborted();
    await new Bun.Video(source).remux(output);
  }
  const proof = await verifyNativeVideos(source, output, { signal });
  const passed = proof.complete && proof.rgbaExact && proof.audioExact;
  const receipt = {
    scope: "complete-encoded-source-native-MP4-preservation",
    source,
    output,
    method: "Bun.Video.remux preserves encoded access units; no video encoder or external process",
    authoredReconstruction: false,
    imageSequenceReencoded: false,
    encodedSourceSha256: await hashEpisodeFile(source),
    outputSha256: await hashEpisodeFile(output),
    ...proof,
    passed,
    limitations: [
      "Independent authored frames are not encoded by this replay mode",
      "PCM-window equality is measured separately from the access-unit preservation guaranteed by the native remux owner",
      "No cross-decoder equality to previously extracted frames is inferred",
    ],
  };
  await mkdir(join(dir, "verification"), { recursive: true });
  await Bun.write(join(dir, "verification/episode-replay.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      scope: receipt.scope,
      frames: proof.checkedFrames,
      complete: proof.complete,
      rgbaExact: proof.rgbaExact,
      audioExact: proof.audioExact,
      passed,
      receipt: "verification/episode-replay.json",
    }),
  );
  if (!passed) throw new Error("Native replay failed complete exact verification; inspect the receipt");
}
if (import.meta.main) await main();
