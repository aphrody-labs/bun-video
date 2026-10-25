import { mkdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface VideoRenderTask {
  id?: string;
  source: { kind: "file" | "direct" | "page" | "capture"; value: string; requestId?: string };
  engine: "remotion" | "hyperframes";
  output: string;
  width: number;
  height: number;
  fps: number | { num: number; den: number };
  durationFrames: number;
  frameWorkers?: number;
  videoFrameFormat?: "png" | "jpg";
  composition?: { entry: string; id?: string };
  browserExecutable?: string;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
  engineExecutable?: string;
  enginePrefix?: string[];
  timeoutMs?: number;
  workDirectory?: string;
}

export interface VideoRenderResult {
  output: string;
  engine: "remotion" | "hyperframes";
  sourcePath: string;
  compositionEntry: string;
  frames: number;
  sha256: string;
  bytes: number;
  codec?: string;
  pixelFormat?: string;
  lossless?: boolean;
  sourceCodec?: string;
  rendererSourceMode?: "video" | "decoded-frames";
}

export function videoTaskFrameRate(fps: VideoRenderTask["fps"]) {
  if (typeof fps === "number") {
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new RangeError("Invalid fps");
    return { value: fps, argument: String(fps) };
  }
  if (
    !fps ||
    !Number.isSafeInteger(fps.num) ||
    !Number.isSafeInteger(fps.den) ||
    fps.num < 1 ||
    fps.den < 1 ||
    fps.num > 0xffffffff ||
    fps.den > 0xffffffff ||
    fps.num > fps.den * 240
  )
    throw new RangeError("Invalid rational fps");
  return { value: fps.num / fps.den, argument: `${fps.num}/${fps.den}` };
}

/** The renderer's numbered frames must be complete before image2 encoding. */
export function validatePNGSequence(files: readonly string[], frameCount: number) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || files.length !== frameCount)
    throw new Error("Rendered PNG sequence does not match the requested frame count");
  const frames = files
    .map(file => {
      const match = /^([a-zA-Z0-9_-]*?)(\d+)\.png$/.exec(file);
      if (!match) throw new Error("Renderer PNG frame names must have a safe numeric suffix");
      return { file, prefix: match[1]!, digits: match[2]!, frame: Number(match[2]) };
    })
    .sort((a, b) => a.frame - b.frame);
  const first = frames[0]!;
  for (let index = 0; index < frames.length; index++) {
    const current = frames[index]!;
    if (
      !Number.isSafeInteger(current.frame) ||
      current.frame !== first.frame + index ||
      current.prefix !== first.prefix ||
      current.digits.length !== first.digits.length
    )
      throw new Error("Renderer PNG frames must be consecutive and consistently named");
  }
  return { pattern: `${first.prefix}%0${first.digits.length}d.png`, startNumber: first.frame };
}

function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("Media URLs must be HTTP(S) without embedded credentials");
  return url;
}

export function validateVideoTask(input: VideoRenderTask): VideoRenderTask {
  if (!input || !["remotion", "hyperframes"].includes(input.engine)) throw new TypeError("Unknown video engine");
  if (!input.source || !["file", "direct", "page", "capture"].includes(input.source.kind) || !input.source.value)
    throw new TypeError("A video source is required");
  for (const [key, max] of [
    ["width", 16384],
    ["height", 16384],
    ["durationFrames", 10000000],
  ] as const)
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > max) throw new RangeError(`Invalid ${key}`);
  if (input.width * input.height > 7680 * 4320) throw new RangeError("Frame exceeds the 8K pixel budget");
  videoTaskFrameRate(input.fps);
  if (
    input.frameWorkers !== undefined &&
    (!Number.isSafeInteger(input.frameWorkers) || input.frameWorkers < 1 || input.frameWorkers > 4)
  )
    throw new RangeError("frameWorkers must be between 1 and 4");
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3600000)
  )
    throw new RangeError("Invalid timeoutMs");
  if (input.videoFrameFormat !== undefined && !["png", "jpg"].includes(input.videoFrameFormat))
    throw new TypeError("videoFrameFormat must be png or jpg");
  if (input.id !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) throw new TypeError("Invalid task id");
  if (input.output.includes("\0") || !isAbsolute(input.output))
    throw new TypeError("Output must be an absolute path without NUL");
  for (const path of [
    input.browserExecutable,
    input.ffmpegExecutable,
    input.ffprobeExecutable,
    input.engineExecutable,
    input.workDirectory,
    input.composition?.entry,
  ])
    if (path !== undefined && (path.includes("\0") || !isAbsolute(path)))
      throw new TypeError("Executable, composition and work paths must be absolute");
  if (
    input.enginePrefix !== undefined &&
    (!Array.isArray(input.enginePrefix) ||
      !input.enginePrefix.every(value => typeof value === "string" && !value.includes("\0")))
  )
    throw new TypeError("Invalid engine prefix");
  if (["direct", "page"].includes(input.source.kind)) httpUrl(input.source.value);
  else if (!isAbsolute(input.source.value)) throw new TypeError("File and capture paths must be absolute");
  return input;
}

const packageRoot = () => resolve(Bun.env.BUN_VIDEO_PACKAGE_ROOT ?? join(import.meta.dir, ".."));
const defaultJobsRoot = () =>
  join(
    Bun.env.APHRODY_HOME ??
      join(
        Bun.env.USERPROFILE ??
          Bun.env.HOME ??
          (() => {
            throw new Error("A protected work directory is required");
          })(),
        ".aphrody",
      ),
    "data",
    "bun-video",
    "jobs",
  );
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

async function downloadDirect(url: string, directory: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(httpUrl(url), { signal });
  if (!response.ok || !response.body) throw new Error(`Media download HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES)
    throw new RangeError("Media exceeds the 4 GiB per-job download limit");
  const contentType = response.headers.get("content-type") ?? "";
  if (/html|json|mpegurl|dash\+xml/.test(contentType))
    throw new TypeError("A direct source must be a media file; use page acquisition for playlists");
  const extension = /webm/.test(contentType) ? ".webm" : /quicktime/.test(contentType) ? ".mov" : ".mp4";
  const path = join(directory, `source${extension}`);
  const writer = Bun.file(path).writer();
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new RangeError("Media exceeds the 4 GiB per-job download limit");
      writer.write(chunk);
      await writer.flush();
    }
  } finally {
    await writer.end();
  }
  if (!size) throw new Error("Media download is empty");
  return path;
}

async function downloadPage(
  url: string,
  directory: string,
  task: VideoRenderTask,
  signal: AbortSignal,
): Promise<string> {
  const { runYtDlp } = await import("./ytdlp");
  const result = await runYtDlp({
    url,
    vendorRoot: join(packageRoot(), "yt-dlp"),
    signal,
    options: {
      download: true,
      outtmpl: join(directory, "source.%(ext)s"),
      noplaylist: true,
      format: "bestvideo+bestaudio/best",
      merge_output_format: "mp4",
      ...(task.ffmpegExecutable ? { ffmpeg_location: task.ffmpegExecutable } : {}),
      socket_timeout: Math.max(1, Math.ceil((task.timeoutMs ?? 120000) / 1000)),
    },
  });
  const candidates = [result.filepath, result._filename, join(directory, "source.mp4")].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (dirname(path) === resolve(directory) && (await Bun.file(path).exists()) && Bun.file(path).size > 0) return path;
  }
  for await (const path of new Bun.Glob("source.*").scan({ cwd: directory, onlyFiles: true }))
    if (/^source\.[^.]+$/.test(path) && !/\.(part|ytdl|json)$/.test(path) && Bun.file(join(directory, path)).size > 0)
      return join(directory, path);
  throw new Error("yt-dlp did not produce a media file");
}

async function acquireSource(task: VideoRenderTask, directory: string, signal: AbortSignal): Promise<string> {
  if (task.source.kind === "file") {
    if (!(await Bun.file(task.source.value).exists()) || !Bun.file(task.source.value).size)
      throw new Error("Local source is missing or empty");
    return resolve(task.source.value);
  }
  if (task.source.kind === "page") return downloadPage(task.source.value, directory, task, signal);
  let url = task.source.value;
  let playlist = false;
  if (task.source.kind === "capture") {
    const capture = (await Bun.file(task.source.value).json()) as {
      requests?: {
        requestId: string;
        request?: { url?: string };
        response?: { mimeType?: string; status?: number };
        bodyFile?: string;
        encrypted?: boolean;
        complete?: boolean;
      }[];
    };
    const requests = (capture.requests ?? []).filter(row => {
      const media =
        /(?:video\/|mpegurl|dash\+xml)/i.test(row.response?.mimeType ?? "") ||
        /\.(?:mp4|webm|m3u8|mpd)(?:[?#]|$)/i.test(row.request?.url ?? "");
      return media && (!task.source.requestId || row.requestId === task.source.requestId);
    });
    if (requests.length !== 1)
      throw new Error("Capture must identify exactly one video request; supply requestId for ambiguous captures");
    const selected = requests[0]!;
    if (!selected.request?.url) throw new Error("Selected capture request has no URL");
    if (selected.encrypted || /\/(?:cenc|widevine|playready)\//i.test(new URL(selected.request.url).pathname))
      throw new Error("Captured media is encrypted; ciphertext cannot be rendered as a clear video");
    if (selected.complete === false)
      throw new Error("Captured media is incomplete; select a complete decodable source");
    url = selected.request.url;
    playlist = /mpegurl|dash\+xml/i.test(selected.response?.mimeType ?? "");
    if (selected.bodyFile && selected.response?.status === 200 && /^video\//i.test(selected.response.mimeType ?? "")) {
      const root = dirname(task.source.value);
      const bodyPath = resolve(root, selected.bodyFile);
      const inside = relative(root, bodyPath);
      if (inside.startsWith("..") || isAbsolute(inside))
        throw new TypeError("Captured body escapes its private export directory");
      if ((await Bun.file(bodyPath).exists()) && Bun.file(bodyPath).size) {
        const path = join(directory, /webm/i.test(selected.response.mimeType ?? "") ? "source.webm" : "source.mp4");
        await Bun.write(path, Bun.file(bodyPath));
        return path;
      }
    }
  }
  if (playlist || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) return downloadPage(url, directory, task, signal);
  return downloadDirect(url, directory, signal);
}

async function makeComposition(
  task: VideoRenderTask,
  sourcePath: string,
  directory: string,
  hasAudio: boolean,
  sourceCodec: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (task.composition) {
    if (!(await Bun.file(task.composition.entry).exists())) throw new Error("Composition entry is missing");
    return task.composition.entry;
  }
  if (task.engine === "remotion") {
    const publicDirectory = join(directory, "public");
    mkdirSync(publicDirectory, { recursive: true });
    if (sourceCodec === "ffv1") {
      const ffmpeg = task.ffmpegExecutable ?? Bun.env.BUN_VIDEO_FFMPEG ?? Bun.which("ffmpeg");
      if (!ffmpeg || !isAbsolute(ffmpeg))
        throw new Error("FFV1 source frames require an absolute native FFmpeg executable");
      const sourceFrames = join(publicDirectory, "source-frames");
      mkdirSync(sourceFrames, { recursive: true });
      await runProcess(
        [
          ffmpeg,
          "-v",
          "error",
          "-i",
          sourcePath,
          "-map",
          "0:v:0",
          "-vf",
          `fps=${videoTaskFrameRate(task.fps).argument}`,
          "-frames:v",
          String(task.durationFrames),
          "-start_number",
          "0",
          "-pix_fmt",
          "rgba",
          "-n",
          join(sourceFrames, "frame_%06d.png"),
        ],
        directory,
        signal,
        "decode-source-frames",
      );
      const frames = await Array.fromAsync(new Bun.Glob("*.png").scan({ cwd: sourceFrames, onlyFiles: true }));
      validatePNGSequence(frames, task.durationFrames);
      if (hasAudio)
        await runProcess(
          [
            ffmpeg,
            "-v",
            "error",
            "-i",
            sourcePath,
            "-map",
            "0:a:0",
            "-vn",
            "-t",
            String(task.durationFrames / videoTaskFrameRate(task.fps).value),
            "-c:a",
            "pcm_s16le",
            "-n",
            join(publicDirectory, "source-audio.wav"),
          ],
          directory,
          signal,
          "decode-source-audio",
        );
      const entry = join(directory, "composition.tsx");
      const audio = hasAudio ? `React.createElement(Audio,{src:staticFile("source-audio.wav")})` : "null";
      await Bun.write(
        entry,
        `import React from "react";\nimport {registerRoot,Composition,AbsoluteFill,Img,Audio,useCurrentFrame,staticFile} from "remotion";\nconst Clip=()=>{const frame=useCurrentFrame();return React.createElement(AbsoluteFill,{style:{backgroundColor:'black'}},React.createElement(Img,{src:staticFile("source-frames/frame_"+String(frame).padStart(6,"0")+".png"),style:{width:'100%',height:'100%',objectFit:'contain'}}),${audio});};\nregisterRoot(()=>React.createElement(Composition,{id:'VideoSource',component:Clip,width:${task.width},height:${task.height},fps:${videoTaskFrameRate(task.fps).value},durationInFrames:${task.durationFrames}}));\n`,
      );
      return entry;
    }
    const assetName = `media${extname(sourcePath) || ".mp4"}`;
    const assetPath = join(publicDirectory, assetName);
    if (resolve(assetPath) !== resolve(sourcePath)) await Bun.write(assetPath, Bun.file(sourcePath));
    const entry = join(directory, "composition.tsx");
    // The engine aliases these package IDs to one materialized React/Remotion instance.
    const code = `import React from "react";\nimport {registerRoot,Composition,AbsoluteFill,OffthreadVideo,staticFile} from "remotion";\nconst Clip=()=>React.createElement(AbsoluteFill,{style:{backgroundColor:'black'}},React.createElement(OffthreadVideo,{src:staticFile(${JSON.stringify(assetName)}),style:{width:'100%',height:'100%',objectFit:'contain'}}));\nregisterRoot(()=>React.createElement(Composition,{id:'VideoSource',component:Clip,width:${task.width},height:${task.height},fps:${videoTaskFrameRate(task.fps).value},durationInFrames:${task.durationFrames}}));\n`;
    await Bun.write(entry, code);
    return entry;
  }
  const extension = extname(sourcePath) || ".mp4";
  const asset = join(directory, `media${extension}`);
  if (resolve(asset) !== resolve(sourcePath)) await Bun.write(asset, Bun.file(sourcePath));
  const gsap = join(packageRoot(), "hyperframes", "skills", "talking-head-recut", "assets", "vendor", "gsap.min.js");
  if (!(await Bun.file(gsap).exists()))
    throw new Error("HyperFrames GSAP asset is missing; configure BUN_VIDEO_PACKAGE_ROOT or provide composition.entry");
  await Bun.write(join(directory, "gsap.min.js"), Bun.file(gsap));
  const seconds = task.durationFrames / videoTaskFrameRate(task.fps).value;
  const entry = join(directory, "index.html");
  await Bun.write(
    entry,
    `<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=${task.width}, height=${task.height}"><title>Video source</title><script src="gsap.min.js"></script><style>html,body{width:${task.width}px;height:${task.height}px;margin:0;background:#000}#root{position:relative;width:100%;height:100%;overflow:hidden}.clip{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style></head><body><div id="root" data-composition-id="VideoSource" data-start="0" data-width="${task.width}" data-height="${task.height}" data-fps="${videoTaskFrameRate(task.fps).argument}" data-duration="${seconds}"><video id="source-video" class="clip" src="${Bun.escapeHTML(basename(asset))}" data-start="0" data-duration="${seconds}" data-media-start="0" data-track-index="0" data-has-audio="${hasAudio}"></video></div><script>window.__timelines=window.__timelines||{};window.__timelines["VideoSource"]=gsap.timeline({paused:true});</script></body></html>`,
  );
  return entry;
}

async function runProcess(
  args: string[],
  directory: string,
  signal: AbortSignal,
  label: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  signal.throwIfAborted();
  const child = Bun.spawn(args, {
    cwd: directory,
    stdin: "ignore",
    stdout: Bun.file(join(directory, `${label}.stdout.log`)),
    stderr: Bun.file(join(directory, `${label}.stderr.log`)),
    env: { ...Bun.env, ...env },
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await child.exited;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`${label} exited ${code}; diagnostics remain in the private job directory`);
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

export async function executeVideoTask(
  input: VideoRenderTask,
  options: { signal?: AbortSignal } = {},
): Promise<VideoRenderResult> {
  const task = validateVideoTask(input);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(task.timeoutMs ?? 120000)])
    : AbortSignal.timeout(task.timeoutMs ?? 120000);
  signal.throwIfAborted();
  if (await Bun.file(task.output).exists()) throw new Error("Output already exists; choose a fresh output path");
  const executable =
    task.engineExecutable ?? Bun.env[`BUN_VIDEO_${task.engine.toUpperCase()}`] ?? Bun.env.BUN_VIDEO_ENGINE;
  if (!executable || !isAbsolute(executable)) throw new Error(`Configure an absolute ${task.engine} engine executable`);
  const ffprobe = task.ffprobeExecutable ?? Bun.env.HYPERFRAMES_FFPROBE_PATH ?? Bun.which("ffprobe");
  const prefix = task.enginePrefix ?? (Bun.env.BUN_VIDEO_ENGINE === executable ? [task.engine] : []);
  const directory = task.workDirectory ?? join(defaultJobsRoot(), task.id ?? crypto.randomUUID());
  mkdirSync(directory, { recursive: true });
  mkdirSync(dirname(task.output), { recursive: true });
  const sourcePath = await acquireSource(task, directory, signal);
  if (!ffprobe) throw new Error("A qualified ffprobe executable is required to inspect and verify video media");
  await runProcess(
    [ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", sourcePath],
    directory,
    signal,
    "source-probe",
  );
  const sourceProbe = (await Bun.file(join(directory, "source-probe.stdout.log")).json()) as {
    streams?: { codec_type?: string; codec_name?: string }[];
  };
  const hasAudio = sourceProbe.streams?.some(stream => stream.codec_type === "audio") ?? false;
  const sourceCodec = sourceProbe.streams?.find(stream => stream.codec_type === "video")?.codec_name;
  const compositionEntry = await makeComposition(task, sourcePath, directory, hasAudio, sourceCodec, signal);
  const workers = task.frameWorkers ?? 1;
  const lossless = extname(task.output).toLowerCase() === ".mkv";
  const frameDirectory = join(directory, "rendered-frames");
  const renderOutput = lossless ? frameDirectory : task.output;
  let expectedAudio = hasAudio;
  const ffmpeg = task.ffmpegExecutable ?? Bun.env.BUN_VIDEO_FFMPEG ?? Bun.which("ffmpeg");
  if (lossless && (!ffmpeg || !isAbsolute(ffmpeg)))
    throw new Error("Lossless MKV output requires an absolute FFmpeg executable");
  const args =
    task.engine === "remotion"
      ? [
          executable,
          ...prefix,
          "render",
          compositionEntry,
          task.composition?.id ?? "VideoSource",
          renderOutput,
          "--frames",
          `0-${task.durationFrames - 1}`,
          "--concurrency",
          String(workers),
          ...(!task.composition ? ["--public-dir", join(directory, "public")] : []),
          ...(extname(task.output).toLowerCase() === ".mov" ? ["--codec", "prores"] : []),
          ...(lossless ? ["--sequence", "--image-format", "png"] : []),
          ...(task.browserExecutable ? ["--browser-executable", task.browserExecutable] : []),
        ]
      : [
          executable,
          ...prefix,
          "render",
          dirname(compositionEntry),
          "--composition",
          basename(compositionEntry),
          "--output",
          renderOutput,
          ...(extname(task.output).toLowerCase() === ".mov" ? ["--format", "mov"] : []),
          ...(lossless ? ["--format", "png-sequence"] : []),
          "--fps",
          videoTaskFrameRate(task.fps).argument,
          "--workers",
          String(workers),
          "--video-frame-format",
          lossless ? "png" : (task.videoFrameFormat ?? "png"),
        ];
  await runProcess(args, directory, signal, "render", {
    ...(task.browserExecutable
      ? { HYPERFRAMES_BROWSER_PATH: task.browserExecutable, PUPPETEER_EXECUTABLE_PATH: task.browserExecutable }
      : {}),
    ...(task.ffmpegExecutable
      ? { HYPERFRAMES_FFMPEG_PATH: task.ffmpegExecutable, BUN_VIDEO_FFMPEG: task.ffmpegExecutable }
      : {}),
    ...(task.ffprobeExecutable ? { HYPERFRAMES_FFPROBE_PATH: task.ffprobeExecutable } : {}),
    BUN_VIDEO_SOURCE: sourcePath,
  });
  if (lossless) {
    const files = await Array.fromAsync(new Bun.Glob("*.png").scan({ cwd: frameDirectory, onlyFiles: true }));
    const sequence = validatePNGSequence(files, task.durationFrames);
    let audioPath = join(frameDirectory, "audio.m4a");
    if (task.engine === "remotion" && (hasAudio || task.composition)) {
      audioPath = join(directory, "composition-audio.wav");
      await runProcess(
        [
          executable,
          ...prefix,
          "render",
          compositionEntry,
          task.composition?.id ?? "VideoSource",
          audioPath,
          "--codec",
          "wav",
          "--frames",
          `0-${task.durationFrames - 1}`,
          "--concurrency",
          String(workers),
          ...(!task.composition ? ["--public-dir", join(directory, "public")] : []),
          ...(task.composition ? ["--enforce-audio-track"] : []),
          ...(task.browserExecutable ? ["--browser-executable", task.browserExecutable] : []),
        ],
        directory,
        signal,
        "render-audio",
        { BUN_VIDEO_SOURCE: sourcePath },
      );
    }
    const hasMixedAudio = await Bun.file(audioPath).exists();
    expectedAudio = hasMixedAudio;
    if (hasAudio && !hasMixedAudio)
      throw new Error("Renderer did not provide the composition audio for lossless muxing");
    await runProcess(
      [
        ffmpeg!,
        "-v",
        "error",
        "-framerate",
        videoTaskFrameRate(task.fps).argument,
        "-start_number",
        String(sequence.startNumber),
        "-i",
        join(frameDirectory, sequence.pattern),
        ...(hasMixedAudio ? ["-i", audioPath] : []),
        "-map",
        "0:v:0",
        ...(hasMixedAudio ? ["-map", "1:a:0"] : []),
        "-frames:v",
        String(task.durationFrames),
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-pix_fmt",
        "bgra",
        ...(hasMixedAudio ? ["-c:a", "copy"] : []),
        "-n",
        task.output,
      ],
      directory,
      signal,
      "encode-lossless",
    );
  }
  const output = Bun.file(task.output);
  if (!(await output.exists()) || !output.size) throw new Error("Engine produced no video output");
  await runProcess(
    [
      ffprobe,
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames,r_frame_rate",
      "-of",
      "json",
      task.output,
    ],
    directory,
    signal,
    "probe",
  );
  const probe = (await Bun.file(join(directory, "probe.stdout.log")).json()) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width: number;
      height: number;
      nb_read_frames?: string;
      r_frame_rate?: string;
    }[];
  };
  const stream = probe.streams?.find(value => value.codec_type === "video");
  const frames = Number(stream?.nb_read_frames);
  const [numerator, denominator] = (stream?.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = (numerator ?? 0) / (denominator ?? 1);
  if (
    !stream ||
    stream.width !== task.width ||
    stream.height !== task.height ||
    frames !== task.durationFrames ||
    Math.abs(fps - videoTaskFrameRate(task.fps).value) > 0.000001
  )
    throw new Error("Encoded output does not match the requested dimensions, fps and frame count");
  if (lossless && (stream.codec_name !== "ffv1" || stream.pix_fmt !== "bgra"))
    throw new Error("Lossless output must be verified FFV1 BGRA video");
  if (expectedAudio && !probe.streams?.some(value => value.codec_type === "audio"))
    throw new Error("Encoded output is missing the expected composition audio");
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of output.stream()) {
    signal.throwIfAborted();
    hasher.update(chunk);
  }
  return {
    output: task.output,
    engine: task.engine,
    sourcePath,
    compositionEntry,
    frames,
    sha256: hasher.digest("hex"),
    bytes: output.size,
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    lossless,
    sourceCodec,
    rendererSourceMode:
      !task.composition && task.engine === "remotion" && sourceCodec === "ffv1" ? "decoded-frames" : "video",
  };
}
