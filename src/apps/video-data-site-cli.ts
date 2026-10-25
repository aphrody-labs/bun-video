#!/usr/bin/env bun
import { createVideoDataSite } from "../video-data-site";
import { VideoCookieVault, defaultVideoCookieVaultPath } from "../video-cookies";

export async function videoDataSiteMain(args = Bun.argv.slice(2)) {
  if (args.includes("--vault-env")) {
    args = args.filter(argument => argument !== "--vault-env");
    if (!(await Bun.file(defaultVideoCookieVaultPath()).exists())) throw new Error("Private video vault unavailable");
    using vault = new VideoCookieVault();
    const text = await vault.loadEnvironment();
    const names = new Set([
      "BUN_VIDEO_REMOTION",
      "BUN_VIDEO_HYPERFRAMES",
      "BUN_VIDEO_ENGINE",
      "BUN_VIDEO_FFMPEG",
      "BUN_VIDEO_FFPROBE",
      "BUN_VIDEO_PACKAGE_ROOT",
      "BUN_PYTHON_HOST_LIBRARY",
      "BUV_PYTHON_LIBPYTHON",
      "BUN_PYTHON_LIBPYTHON",
      "BUN_PYTHON_EXECUTABLE",
      "BUV_RUNTIME",
      "PYTHONHOME",
      "BUN_VIDEO_REDIS_URL",
    ]);
    const values: [string, string][] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const match = /^([A-Z][A-Z0-9_]*)=([^\r\n\0]*)$/.exec(line);
      if (!match || !names.has(match[1]!)) throw new TypeError("Unsupported private video environment entry");
      values.push([match[1]!, match[2]!]);
    }
    for (const [name, value] of values) Bun.env[name] = value;
  }
  if (args[0] === "--video-worker") {
    const { runVideoWorkerEntry } = await import("../video-worker-entry");
    if (args.length !== 3) throw new TypeError("Worker requires private request/result paths");
    process.exitCode = await runVideoWorkerEntry(args[1]!, args[2]!);
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--help" || flag === "-h") {
      console.log(
        "bun-video site [--vault-env] [--db absolute.sqlite] [--port 0..65535] [--private-root directory] [--workers 1..4]\n--vault-env loads the encrypted, explicit video configuration in memory. Redis: explicit BUN_VIDEO_REDIS_URL only. Loopback server; curated metadata and datasets.",
      );
      return;
    }
    if (!["--db", "--port", "--private-root", "--workers"].includes(flag) || !args[i + 1])
      throw new TypeError("Unknown or incomplete site option");
    values.set(flag, args[++i]!);
  }
  const site = await createVideoDataSite({
    dbPath: values.get("--db"),
    port: Number(values.get("--port") ?? 0),
    privateRoot: values.get("--private-root"),
    workers: Number(values.get("--workers") ?? 2),
    redisURL: Bun.env.BUN_VIDEO_REDIS_URL,
  });
  console.log(JSON.stringify({ url: site.url, runtime: "Bun" }));
  const stop = () => {
    void site.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (import.meta.main) await videoDataSiteMain();

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = videoDataSiteMain;
