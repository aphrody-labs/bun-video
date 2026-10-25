#!/usr/bin/env bun
export {};

type Command = { usage: string; run: (args: string[]) => Promise<unknown> };

/** Every package entry point shares this table; each module is imported only when its command runs. */
const commands: Record<string, Command> = {
  site: {
    usage: "site [--port N]",
    run: args => import("../src/apps/video-data-site-cli").then(mod => mod.run(args)),
  },
  workers: {
    usage: "workers <command> [args]",
    run: args => import("../src/apps/video-workers-cli").then(mod => mod.run(args)),
  },
  chrome: {
    usage: "chrome [args]",
    run: args => import("../src/apps/crunchyroll-app").then(mod => mod.run(args)),
  },
  crunchyroll: {
    usage: "crunchyroll <command> [args]",
    run: args => import("../src/crunchyroll-cli").then(mod => mod.run(args)),
  },
  shortcuts: {
    usage: "shortcuts [args]",
    run: args => import("../src/apps/crunchyroll-shortcuts").then(mod => mod.run(args)),
  },
  dash: { usage: "dash [args]", run: args => guarded(import("../src/apps/dash-live"), args) },
  har: { usage: "har [args]", run: args => guarded(import("../src/apps/har-cli"), args) },
  hls: {
    usage: "hls [args]",
    run: args =>
      guarded(
        import("../src/apps/hls-live"),
        args,
        "HLS command failed; check local files and options. Secret values are omitted.",
      ),
  },
  keychain: { usage: "keychain --migrate|--check", run: args => guarded(import("../src/apps/hls-keychain"), args) },
  webgpu: {
    usage: "webgpu <info|probe|run> [args]",
    run: async args => {
      const { run } = await import("../src/apps/webgpu-cli");
      try {
        await run(args);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  },
  network: {
    usage: "network <url> [args]",
    run: args => import("../src/apps/network-window").then(mod => mod.run(args)),
  },
  ytdlp: {
    usage: "ytdlp [args]",
    run: async args => {
      const { runYtDlpCli } = await import("../src/ytdlp");
      const result = await runYtDlpCli(args);
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    },
  },
  media: {
    usage:
      "media <doctor|inspect|download|extract-frame|extract-frames|extract-audio|gif|remux|cut|compress|serve> [args]",
    run: args =>
      guarded(
        import("../src/media-cli"),
        args,
        "Media command failed; check local files and options. Private URLs and paths are omitted.",
      ),
  },
  watch: {
    usage: "watch <url-or-file> [args]",
    run: args =>
      guarded(
        import("../src/watch-cli"),
        args,
        "Watch failed; check the source and options. Private URLs and paths are omitted.",
      ),
  },
  x: {
    usage: "x <inspect|download> <X status URL> [output]",
    run: async args => {
      try {
        const [action, url, output, ...extra] = args;
        if (extra.length || !url || !["inspect", "download"].includes(action ?? ""))
          throw new Error("invalid-arguments");
        const { normalizeXVideoUrl } = await import("../src/x-source");
        const status = normalizeXVideoUrl(url);
        const { executeMediaJob } = await import("../src/media-workflow");
        const job =
          action === "inspect"
            ? ({ action, source: status.url } as const)
            : output
              ? ({ action: "download", url: status.url, output } as const)
              : undefined;
        if (!job) throw new Error("missing-output");
        console.log(JSON.stringify(await executeMediaJob(job), null, 2));
      } catch {
        console.error(
          "X video command failed; check the public status URL and output path. Private values are omitted.",
        );
        process.exitCode = 1;
      }
    },
  },
  remotion: {
    usage: "remotion <command> [args]",
    run: async args => {
      process.argv = [process.argv[0]!, process.argv[1]!, ...args];
      const { cli } = await import("../remotion/cli/src/index");
      await cli();
    },
  },
  hyperframes: {
    usage: "hyperframes <command> [args]",
    run: async args => {
      process.argv = [process.argv[0]!, process.argv[1]!, ...args];
      process.env.BUN_VIDEO_HYPERFRAMES_CLI_PREFIX = "hyperframes";
      const { mediaAssets } = await import("bun-video:media-runtime");
      process.env.HYPERFRAMES_FFMPEG_PATH ??= mediaAssets.ffmpegExecutable;
      process.env.HYPERFRAMES_FFPROBE_PATH ??= mediaAssets.ffprobeExecutable;
      await import("../hyperframes/cli/src/cli");
    },
  },
  capabilities: {
    usage: "capabilities",
    run: async () =>
      console.log(JSON.stringify(await import("../src/capabilities").then(mod => mod.productCapabilities()), null, 2)),
  },
  "media-probe": {
    usage: "media-probe",
    run: async () => {
      const { mediaAssets } = await import("bun-video:media-runtime");
      const child = Bun.spawn([mediaAssets.nativeExecutable, "probe"], {
        env: { ...process.env, BUN_VIDEO_FFMPEG: mediaAssets.ffmpegExecutable },
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exitCode = await child.exited;
    },
  },
  encode: {
    usage: "encode <frame-plan.json> <absolute-output.mkv>",
    run: async args => {
      if (args.length !== 2) throw new Error("Usage: bun-video encode <frame-plan.json> <absolute-output.mkv>");
      const { mediaAssets } = await import("bun-video:media-runtime");
      const plan = await Bun.file(args[0]!).json();
      const { encodeVideo } = await import("../src/encode");
      console.log(JSON.stringify(await encodeVideo(plan, { ...mediaAssets, output: args[1]! })));
    },
  },
  mcp: { usage: "mcp", run: () => import("../src/mcp").then(mod => mod.serveMcp()) },
};

async function guarded(
  module: Promise<{ run(args: string[]): Promise<void> }>,
  args: string[],
  failure = "Video command failed; check private inputs and options. Captured values are omitted.",
) {
  const { run } = await module;
  try {
    await run(args);
  } catch {
    console.error(failure);
    process.exitCode = 1;
  }
}

function help() {
  console.log(
    Object.values(commands)
      .map(command => "bun-video " + command.usage)
      .join("\n") +
      "\n\nOne executable dispatches the package tools and both upstream CLIs. Native capture requires a qualified browser provider; capabilities reports provider availability.",
  );
}

const [command, ...args] = Bun.argv.slice(2);
if (command === "--video-worker") {
  const { runVideoWorkerEntry } = await import("../src/video-worker-entry");
  if (args.length !== 2) throw new Error("Worker requires private request and result paths");
  process.exitCode = await runVideoWorkerEntry(args[0]!, args[1]!);
} else if (command === undefined || command === "help" || command === "--help" || command === "-h") help();
else if (Object.hasOwn(commands, command)) await commands[command]!.run(args);
else {
  console.error(`Unknown bun-video command: ${command}`);
  process.exitCode = 2;
}
