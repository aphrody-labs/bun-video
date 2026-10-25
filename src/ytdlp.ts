/// <reference path="./media-runtime.d.ts" />
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface YtDlpOptions {
  readonly download?: boolean;
  readonly output?: string;
  readonly format?: string;
  readonly quiet?: boolean;
  readonly noWarnings?: boolean;
  readonly no_warnings?: boolean;
  readonly skipDownload?: boolean;
  readonly skip_download?: boolean;
  readonly extractFlat?: boolean | string;
  readonly extract_flat?: boolean | string;
  readonly noPlaylist?: boolean;
  readonly noplaylist?: boolean;
  readonly cookieFile?: string;
  readonly cookiefile?: string;
  readonly cookiesFromBrowser?: readonly unknown[];
  readonly cookiesfrombrowser?: readonly unknown[];
  readonly ffmpegLocation?: string;
  readonly ffmpeg_location?: string;
  readonly socketTimeout?: number;
  readonly socket_timeout?: number;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  readonly http_headers?: Readonly<Record<string, string>>;
  readonly outtmpl?: string | Readonly<Record<string, string>>;
  readonly js_runtimes?: Readonly<Record<string, { readonly path?: string }>>;
  readonly [key: string]: unknown;
}

export interface YtDlpBridgeOptions {
  readonly vendorRoot?: string;
  readonly signal?: AbortSignal;
}

export interface YtDlpExtractorMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly module: string;
  readonly urlPattern: string | null;
  readonly working: boolean;
}

export interface YtDlpRuntimeInfo {
  readonly available: boolean;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly pythonVersion?: string;
  readonly ytDlpVersion?: string;
  readonly vendorRoot: string;
  readonly hostLibraryPath: string | null;
  readonly libpythonPath: string | null;
  readonly buv: {
    readonly executable: string | null;
    readonly runtimePath: string | null;
    readonly configPath: string | null;
  };
  readonly error?: string;
}

const aliases: Readonly<Record<string, string>> = {
  output: "outtmpl",
  noWarnings: "no_warnings",
  skipDownload: "skip_download",
  extractFlat: "extract_flat",
  noPlaylist: "noplaylist",
  cookieFile: "cookiefile",
  cookiesFromBrowser: "cookiesfrombrowser",
  ffmpegLocation: "ffmpeg_location",
  socketTimeout: "socket_timeout",
  httpHeaders: "http_headers",
  mergeOutputFormat: "merge_output_format",
  playlistItems: "playlist_items",
  writeInfoJson: "writeinfojson",
  writeSubtitles: "writesubtitles",
  writeAutoSubtitles: "writeautomaticsub",
  subtitlesLangs: "subtitleslangs",
  proxyUrl: "proxy",
  userAgent: "user_agent",
  downloadArchive: "download_archive",
  maxDownloads: "max_downloads",
  ageLimit: "age_limit",
};

/** Snake-case options win if their compatibility alias is supplied as well. Unknown yt-dlp options stay intact. */
export function normalizeYtDlpOptions(options: YtDlpOptions = {}): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const target = aliases[key] ?? key;
    if (target !== key && Object.hasOwn(options, target)) continue;
    normalized[target] = value;
  }
  return normalized;
}

async function vendorRoot(options: YtDlpBridgeOptions): Promise<string> {
  const explicit = options.vendorRoot ?? Bun.env.BUN_VIDEO_YTDLP_VENDOR_ROOT;
  if (explicit) return resolve(explicit);
  if (Bun.env.BUN_VIDEO_PACKAGE_ROOT) return resolve(Bun.env.BUN_VIDEO_PACKAGE_ROOT, "yt-dlp");
  if (Bun.isStandaloneExecutable) {
    const vendor = await import("bun-video:ytdlp-vendor");
    return vendor.vendorRoot;
  }
  return Bun.fileURLToPath(new URL("../yt-dlp", import.meta.url));
}

function bunExecutable(): string {
  return Bun.env.BUN_VIDEO_BUN_EXECUTABLE ?? Bun.which("bun") ?? process.execPath;
}

// Keep the CPython owner on its initializing thread. Async sessions attach and detach;
// finalizing between calls can terminate or corrupt CPython extension-module state.
let pythonOwner: import("bun:python").Python | undefined;
function retainPythonOwner(Python: typeof import("bun:python").Python): void {
  if (pythonOwner) return;
  pythonOwner = Python.open();
  process.once("exit", () => pythonOwner?.close());
}

/** Each call owns its namespace; raw options/results are never printed or persisted here. */
async function runBridge<T>(options: YtDlpBridgeOptions, body: string): Promise<T> {
  options.signal?.throwIfAborted();
  const root = await vendorRoot(options);
  if (!(await Bun.file(join(root, "yt_dlp", "__init__.py")).exists()))
    throw new Error("Vendored yt-dlp package is missing");
  const { Python } = await import("bun:python");
  retainPythonOwner(Python);
  await using py = await Python.async();
  const name = `__bun_ytdlp_${crypto.randomUUID().replaceAll("-", "")}`;
  const script = [
    "import json, sys, os",
    "sys.dont_write_bytecode = True",
    `__vendor_root = ${JSON.stringify(root)}`,
    "if __vendor_root not in sys.path: sys.path.insert(0, __vendor_root)",
    "import yt_dlp",
    "if os.path.commonpath([os.path.realpath(yt_dlp.__file__), os.path.realpath(__vendor_root)]) != os.path.realpath(__vendor_root):",
    "    raise RuntimeError('Loaded yt-dlp package does not match the selected vendor root')",
    body,
  ].join("\n");
  try {
    await py.run(`${name} = {}\nexec(${JSON.stringify(script)}, ${name})`);
    options.signal?.throwIfAborted();
    return await py.evalJSON<T>(`${name}['__result']`);
  } finally {
    await py.run(`globals().pop(${JSON.stringify(name)}, None)`);
  }
}

export async function ytDlpRuntimeInfo(options: YtDlpBridgeOptions = {}): Promise<YtDlpRuntimeInfo> {
  const root = await vendorRoot(options);
  let hostLibraryPath: string | null = null;
  let libpythonPath: string | null = null;
  let runtimePath = Bun.env.BUV_RUNTIME ? resolve(Bun.env.BUV_RUNTIME) : null;
  let candidateRuntimePath = runtimePath;
  let configPath: string | null = null;
  let error: string | undefined;
  let versions: { pythonVersion: string; ytDlpVersion: string } | undefined;
  try {
    const bridge = await import("bun:python");
    hostLibraryPath = bridge.pythonHostLibraryPath();
    libpythonPath = bridge.buvLibpython();
    if (!candidateRuntimePath && libpythonPath) {
      const parent = dirname(libpythonPath);
      candidateRuntimePath =
        process.platform === "win32" && basename(parent).toLowerCase() !== "bin" ? parent : dirname(parent);
    }
    if (candidateRuntimePath) {
      const candidate = join(candidateRuntimePath, "share", "buv", "manifest.json");
      if (await Bun.file(candidate).exists()) {
        configPath = candidate;
        runtimePath = candidateRuntimePath;
      }
    }
    versions = await runBridge(
      options,
      "from yt_dlp.version import __version__\n__result = {'pythonVersion': sys.version, 'ytDlpVersion': __version__}",
    );
  } catch (cause) {
    options.signal?.throwIfAborted();
    error = cause instanceof Error ? cause.message : "Native Python host unavailable";
  }
  return {
    available: versions !== undefined,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    vendorRoot: root,
    hostLibraryPath,
    libpythonPath,
    buv: { executable: Bun.which("buv"), runtimePath, configPath },
    ...versions,
    ...(error ? { error } : {}),
  };
}

export async function listYtDlpExtractors(
  options: YtDlpBridgeOptions & { ageLimit?: number } = {},
): Promise<readonly YtDlpExtractorMetadata[]> {
  if (options.ageLimit !== undefined && (!Number.isSafeInteger(options.ageLimit) || options.ageLimit < 0))
    throw new RangeError("Invalid extractor age limit");
  return runBridge(
    options,
    [
      "from yt_dlp.extractor import gen_extractors, list_extractors",
      options.ageLimit === undefined
        ? "__extractors = gen_extractors()"
        : `__extractors = list_extractors(${options.ageLimit})`,
      "__result = [{'id': ie.ie_key(), 'name': ie.IE_NAME, 'description': getattr(ie, 'IE_DESC', None) if isinstance(getattr(ie, 'IE_DESC', None), str) else None, 'module': type(ie).__module__, 'urlPattern': getattr(ie, '_VALID_URL', None), 'working': ie.working()} for ie in __extractors]",
    ].join("\n"),
  );
}

function validateCliArguments(args: readonly string[]): void {
  if (!Array.isArray(args) || !args.every(value => typeof value === "string" && !value.includes("\0")))
    throw new TypeError("yt-dlp arguments must be strings without NUL");
}

/** CLI parsing ignores ambient config; explicit config locations remain caller-owned. */
export async function parseYtDlpOptions(
  args: readonly string[],
  options: YtDlpBridgeOptions = {},
): Promise<{ urls: string[]; options: Record<string, unknown> }> {
  validateCliArguments(args);
  return runBridge(
    options,
    [
      "import io, contextlib",
      `__args = json.loads(${JSON.stringify(JSON.stringify(["--ignore-config", ...args, "--no-js-runtimes", "--js-runtimes", `bun:${bunExecutable()}`]))})`,
      "with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):",
      "    try:",
      "        __parsed = yt_dlp.parse_options(__args)",
      "    except SystemExit as __exit:",
      "        raise ValueError('yt-dlp argument parsing failed with exit code ' + str(__exit.code)) from None",
      "def __plain(value):",
      "    if isinstance(value, dict): return {str(k): __plain(v) for k,v in value.items()}",
      "    if isinstance(value, (list, tuple, set)): return [__plain(v) for v in value]",
      "    if value is None or isinstance(value, (str, int, float, bool)): return value",
      "    return str(value)",
      "__result = {'urls': __parsed.urls, 'options': __plain(__parsed.ydl_opts)}",
    ].join("\n"),
  );
}

/** Full upstream CLI executes inside Bun's native Python session. Captured output may contain private URLs. */
export async function runYtDlpCli(
  args: readonly string[],
  options: YtDlpBridgeOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  validateCliArguments(args);
  return runBridge(
    options,
    [
      "import io, contextlib",
      "from yt_dlp.globals import IN_CLI",
      `__args = json.loads(${JSON.stringify(JSON.stringify(["--ignore-config", ...args, "--no-js-runtimes", "--js-runtimes", `bun:${bunExecutable()}`]))})`,
      "__stdout, __stderr = io.StringIO(), io.StringIO()",
      "__code = 0",
      "__previous_in_cli = IN_CLI.value",
      "try:",
      "    with contextlib.redirect_stdout(__stdout), contextlib.redirect_stderr(__stderr):",
      "        try:",
      "            yt_dlp.main(__args)",
      "        except SystemExit as __exit:",
      "            __code = __exit.code if isinstance(__exit.code, int) else (0 if __exit.code is None else 1)",
      "finally:",
      "    IN_CLI.value = __previous_in_cli",
      "__result = {'exitCode': __code, 'stdout': __stdout.getvalue(), 'stderr': __stderr.getvalue()}",
    ].join("\n"),
  );
}

export interface YtDlpRequest {
  readonly url: string;
  readonly options?: YtDlpOptions;
  readonly vendorRoot?: string;
  /** Root of the caller's protected credential store; cookie files must live beneath it. */
  readonly privateDirectory?: string;
  readonly signal?: AbortSignal;
  /** Maximum bytes accepted by the progress hook. Defaults to 2 GiB. */
  readonly maxBytes?: number;
  /** Maximum download wall time, including live capture. Defaults to 30 minutes. */
  readonly maxDurationSeconds?: number;
  readonly onProgress?: (progress: YtDlpProgress) => void;
}

export interface YtDlpProgress {
  readonly status: "downloading" | "finished";
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly percentage: number | null;
  readonly speedBytesPerSecond: number | null;
  readonly etaSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly filename: string | null;
  readonly formatId: string | null;
}

export interface YtDlpResult {
  readonly id?: string;
  readonly title?: string;
  readonly webpage_url?: string;
  readonly formats?: readonly Record<string, unknown>[];
  readonly entries?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

function validate(request: YtDlpRequest): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new TypeError("yt-dlp URL must be absolute");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("yt-dlp accepts only HTTP(S) URLs without credentials");
  if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0))
    throw new RangeError("maxBytes must be a positive safe integer");
  if (
    request.maxDurationSeconds !== undefined &&
    (!Number.isFinite(request.maxDurationSeconds) ||
      request.maxDurationSeconds <= 0 ||
      request.maxDurationSeconds > 86_400)
  )
    throw new RangeError("maxDurationSeconds must be between 0 and 86400");
}

function safeProgress(value: Record<string, unknown>): YtDlpProgress {
  const downloadedBytes = typeof value.downloaded_bytes === "number" ? value.downloaded_bytes : 0;
  const totalBytes =
    typeof value.total_bytes === "number"
      ? value.total_bytes
      : typeof value.total_bytes_estimate === "number"
        ? value.total_bytes_estimate
        : null;
  const numberOrNull = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : null);
  const filename = typeof value.filename === "string" ? basename(value.filename) : null;
  return {
    status: value.status === "finished" ? "finished" : "downloading",
    downloadedBytes,
    totalBytes,
    percentage: totalBytes && totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : null,
    speedBytesPerSecond: numberOrNull("speed"),
    etaSeconds: numberOrNull("eta"),
    elapsedSeconds: numberOrNull("elapsed"),
    filename,
    formatId: typeof value.format_id === "string" ? value.format_id : null,
  };
}

/** Execute yt-dlp on its Python worker thread and poll cooperative progress/cancellation. */
async function runYtDlpJob(request: YtDlpRequest, options: Record<string, unknown>): Promise<YtDlpResult> {
  request.signal?.throwIfAborted();
  const root = await vendorRoot(request);
  if (!(await Bun.file(join(root, "yt_dlp", "__init__.py")).exists()))
    throw new Error("Vendored yt-dlp package is missing");
  const { Python } = await import("bun:python");
  retainPythonOwner(Python);
  await using py = await Python.async();
  const name = `__bun_ytdlp_job_${crypto.randomUUID().replaceAll("-", "")}`;
  const maxBytes = request.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const maxDuration = request.maxDurationSeconds ?? 1800;
  const socketTimeout = typeof options.socket_timeout === "number" ? options.socket_timeout : 20;
  const boundedOptions = {
    ...options,
    max_filesize: Math.min(typeof options.max_filesize === "number" ? options.max_filesize : maxBytes, maxBytes),
    socket_timeout: Math.min(Math.max(socketTimeout, 1), 120),
    concurrent_fragment_downloads: Math.min(
      Math.max(
        typeof options.concurrent_fragment_downloads === "number" ? options.concurrent_fragment_downloads : 1,
        1,
      ),
      4,
    ),
  };
  const shouldDownload = (boundedOptions as Record<string, unknown>).download === true;
  const script = [
    "import json, sys, os, threading, time",
    "sys.dont_write_bytecode = True",
    `__vendor_root = ${JSON.stringify(root)}`,
    "if __vendor_root not in sys.path: sys.path.insert(0, __vendor_root)",
    "import yt_dlp",
    "if os.path.commonpath([os.path.realpath(yt_dlp.__file__), os.path.realpath(__vendor_root)]) != os.path.realpath(__vendor_root):",
    "    raise RuntimeError('Loaded yt-dlp package does not match the selected vendor root')",
    `__options = json.loads(${JSON.stringify(JSON.stringify(boundedOptions))})`,
    `__url = json.loads(${JSON.stringify(JSON.stringify(request.url))})`,
    `__max_bytes = ${maxBytes}`,
    `__max_duration = ${maxDuration}`,
    "__state = {'done': False, 'cancel': False, 'progress': None, 'result': None, 'error': None, 'cancelReason': None}",
    "def __work():",
    "    try:",
    "        from yt_dlp import YoutubeDL",
    "        from yt_dlp.utils import DownloadError",
    "        class __PrivateLogger:",
    "            def debug(self, message): pass",
    "            def warning(self, message): pass",
    "            def error(self, message): pass",
    "        __options['logger'] = __PrivateLogger()",
    "        __started = time.monotonic()",
    "        def __progress(hook):",
    "            if __state['cancel']:",
    "                raise DownloadError('Download cancelled')",
    "            if time.monotonic() - __started > __max_duration:",
    "                __state['cancelReason'] = 'duration-limit'",
    "                raise DownloadError('Download duration limit reached')",
    "            __downloaded = hook.get('downloaded_bytes', 0) or 0",
    "            if __downloaded > __max_bytes:",
    "                __state['cancelReason'] = 'size-limit'",
    "                raise DownloadError('Download size limit reached')",
    "            __state['progress'] = {k: hook.get(k) for k in ('status', 'downloaded_bytes', 'total_bytes', 'total_bytes_estimate', 'speed', 'eta', 'elapsed', 'filename', 'format_id')}",
    "        __options['progress_hooks'] = [__progress]",
    "        with YoutubeDL(__options) as __ydl:",
    `            __info = __ydl.extract_info(__url, download=${shouldDownload ? "True" : "False"})`,
    "            __raw = __ydl.sanitize_info(__info)",
    "            def __public(value, key=''):",
    "                if isinstance(value, dict): return {str(k): __public(v, str(k).lower()) for k,v in value.items() if str(k).lower() not in {'url', 'manifest_url', 'fragment_base_url', 'http_headers', 'cookies', 'cookiefile', 'requested_downloads', 'filepath', '_filename'}}",
    "                if isinstance(value, (list, tuple)): return [__public(v, key) for v in value]",
    "                if key.endswith('_url') and isinstance(value, str):",
    "                    from urllib.parse import urlsplit, urlunsplit",
    "                    __parts = urlsplit(value)",
    "                    if __parts.scheme in ('http', 'https'): return urlunsplit((__parts.scheme, __parts.hostname or '', __parts.path, '', ''))",
    "                return value",
    "            __state['result'] = __public(__raw)",
    "    except BaseException as __error:",
    "        __state['error'] = type(__error).__name__",
    "    finally:",
    "        __state['done'] = True",
    "__thread = threading.Thread(target=__work, name='bun-ytdlp-download', daemon=True)",
    "__thread.start()",
  ].join("\n");
  const encodedScript = JSON.stringify(script);
  let cancelRequested = false;
  let callbackError: unknown;
  let lastProgress = "";
  const startedAt = Date.now();
  try {
    await py.run(`${name} = {}\nexec(${encodedScript}, ${name})`);
    while (true) {
      if (!cancelRequested && (request.signal?.aborted || Date.now() - startedAt > maxDuration * 1000)) {
        cancelRequested = true;
        await py.run(`${name}['__state']['cancel'] = True`);
      }
      const state = await py.evalJSON<{
        done: boolean;
        cancelReason: string | null;
        error: string | null;
        progress: Record<string, unknown> | null;
        result: YtDlpResult | null;
      }>(`${name}['__state']`);
      if (state.progress && request.onProgress) {
        const key = JSON.stringify(state.progress);
        if (key !== lastProgress) {
          lastProgress = key;
          try {
            request.onProgress(safeProgress(state.progress));
          } catch (cause) {
            callbackError = cause;
            cancelRequested = true;
            await py.run(`${name}['__state']['cancel'] = True`);
          }
        }
      }
      if (state.done) {
        if (callbackError !== undefined) throw callbackError;
        if (request.signal?.aborted) request.signal.throwIfAborted();
        if (Date.now() - startedAt > maxDuration * 1000 || state.cancelReason === "duration-limit")
          throw new Error("yt-dlp download exceeded its configured duration limit");
        if (state.cancelReason === "size-limit") throw new Error("yt-dlp download exceeded its configured size limit");
        if (state.error) throw new Error(`yt-dlp failed (${state.error})`);
        return state.result ?? {};
      }
      await Bun.sleep(100);
    }
  } finally {
    await py.run(`globals().pop(${JSON.stringify(name)}, None)`);
  }
}

/** Run vendored yt-dlp through Bun's embedded CPython host with bounded cooperative cancellation. */
export async function runYtDlp(request: YtDlpRequest): Promise<YtDlpResult> {
  validate(request);
  const normalizedOptions = normalizeYtDlpOptions(request.options);
  const cookieFile = normalizedOptions.cookiefile;
  if (cookieFile !== undefined) {
    if (typeof cookieFile !== "string" || !request.privateDirectory)
      throw new TypeError("yt-dlp cookie files require a protected privateDirectory");
    const [privateRoot, cookiePath] = await Promise.all([
      realpath(resolve(request.privateDirectory)),
      realpath(resolve(cookieFile)).catch(() => ""),
    ]);
    const relativeCookiePath = relative(privateRoot, cookiePath);
    if (
      !cookiePath ||
      relativeCookiePath === ".." ||
      relativeCookiePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeCookiePath) ||
      !(await Bun.file(cookiePath).exists())
    )
      throw new TypeError("yt-dlp cookie files must exist inside the protected privateDirectory");
  }
  if (normalizedOptions.cookiesfrombrowser !== undefined)
    throw new TypeError("yt-dlp browser cookies are disabled; use a protected cookie file path");
  const options: Record<string, unknown> = {
    quiet: true,
    no_warnings: true,
    ...normalizedOptions,
    js_runtimes: { bun: { path: bunExecutable() } },
  };
  return runYtDlpJob(request, options);
}

export async function extractYtDlp(url: string, options: YtDlpOptions = {}): Promise<YtDlpResult> {
  return await runYtDlp({ url, options: { skip_download: true, ...options } });
}

export async function listYtDlpFormats(
  url: string,
  options: YtDlpOptions = {},
): Promise<readonly Record<string, unknown>[]> {
  const result = await extractYtDlp(url, options);
  return result.formats ?? [];
}

const activeYtDlpOutputs = new Set<string>();

export async function downloadYtDlp(
  url: string,
  output: string,
  options: YtDlpOptions = {},
  controls: Pick<
    YtDlpRequest,
    "signal" | "maxBytes" | "maxDurationSeconds" | "onProgress" | "vendorRoot" | "privateDirectory"
  > = {},
): Promise<YtDlpResult & { readonly localPath: string }> {
  const destination = resolve(output);
  if (await Bun.file(destination).exists()) throw new Error("yt-dlp output already exists");
  if (await Bun.file(`${destination}.part`).exists()) throw new Error("yt-dlp partial output already exists");
  if (activeYtDlpOutputs.has(destination)) throw new Error("yt-dlp output is already being written");
  activeYtDlpOutputs.add(destination);
  let ownsOutput = false;
  try {
    const result = await runYtDlp({
      url,
      options: { ...options, download: true, nooverwrites: true, outtmpl: destination },
      ...controls,
    });
    const file = Bun.file(destination);
    if (!(await file.exists())) throw new Error("yt-dlp completed without producing the requested output");
    ownsOutput = true;
    if (file.size > (controls.maxBytes ?? 2 * 1024 * 1024 * 1024))
      throw new Error("yt-dlp output exceeded its configured size limit");
    return { ...result, localPath: destination };
  } catch (error) {
    const partial = Bun.file(`${destination}.part`);
    if (await partial.exists()) await partial.delete();
    if (ownsOutput && (await Bun.file(destination).exists())) await Bun.file(destination).delete();
    throw error;
  } finally {
    activeYtDlpOutputs.delete(destination);
  }
}

export async function extractYtDlpPlaylist(
  url: string,
  options: YtDlpOptions = {},
): Promise<readonly Record<string, unknown>[]> {
  const result = await extractYtDlp(url, { extract_flat: true, ...options });
  return result.entries ?? [];
}
