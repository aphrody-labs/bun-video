/** Lazy ownership registry. Loading a module never constitutes playback qualification. */
const owners = {
  api: () => import("./video-api"),
  catalog: () => import("./video-catalog"),
  workers: () => import("./video-workers"),
  workflow: () => import("./video-workflow"),
  "pixel-verify": () => import("./pixel-verify"),
  "video-capture": () => import("./video-capture"),
  "archive-capture": () => import("./archive-capture"),
  "video-dataset": () => import("./video-dataset"),
  "video-cookies": () => import("./video-cookies"),
  "data-site": () => import("./video-data-site"),
  publish: () => import("./video-publish"),
  hls: () => import("./hls"),
  playback: () => import("./playback"),
  dash: () => import("./dash"),
  har: () => import("./har"),
  bitmovin: () => import("./bitmovin"),
  crunchyroll: () => import("./crunchyroll"),
  "crunchyroll-api": () => import("./crunchyroll-api"),
  "crunchyroll-cli": () => import("./crunchyroll-cli"),
  "crunchyroll-service": () => import("./crunchyroll-service"),
  "crunchyroll-watchlist": () => import("./crunchyroll-watchlist"),
  "frame-theme": () => import("./frame-theme"),
  "frame-analysis": () => import("./frame-analysis"),
  "episode-assets": () => import("./episode-assets"),
  "episode-unpack": () => import("./episode-unpack"),
  "episode-dataset": () => import("./episode-dataset"),
  "pixel-svg": () => import("./pixel-svg"),
  "shenron-episode": () => import("./shenron-episode"),
  oauth: () => import("./oauth"),
  secrets: () => import("./secrets"),
  webgpu: () => import("./webgpu"),
  mediabunny: () => import("../mediabunny/src/index"),
  ytdlp: () => import("./ytdlp"),
  pipeline: () => import("./pipeline"),
  image: () => import("./image"),
  formats: () => import("./formats"),
  source: () => import("./source"),
  cache: () => import("./cache"),
  archive: () => import("./archive"),
  studio: () => import("./studio"),
  "studio-remotion": () => import("./studio-remotion"),
  encode: () => import("./encode"),
  computer: () => import("./computer"),
  ffmpeg: () => import("./ffmpeg"),
  mpv: () => import("./mpv"),
  sdk: () => import("./sdk"),
  remotion: () => import("../remotion/core/src/index"),
  "remotion-renderer": () => import("../remotion/renderer/src/index"),
  hyperframes: () => import("../hyperframes/core/src/index"),
  "hyperframes-engine": () => import("../hyperframes/engine/src/index"),
  capabilities: () => import("./capabilities"),
  mcp: () => import("./mcp"),
  "render-runtime": () => import("./render-runtime"),
  "render-frame": () => import("./render-frame"),
  "parallel-capture": () => import("./parallel-capture"),
  "frame-plan": () => import("./frame-plan"),
  "remotion-frame": () => import("./remotion-frame"),
  "hyperframes-native": () => import("./hyperframes-native"),
  media: () => import("./media-workflow"),
  "x-source": () => import("./x-source"),
  photocraft: () => import("./photocraft"),
  "m3-video": () => import("./m3-video"),
  watch: () => import("./watch"),
  "watch-catalogue": () => import("./watch-catalogue"),
  "watch-shenron": () => import("./watch-shenron"),
  "video-watch": () => import("./video-watch"),
  "video-verify": () => import("./video-verify"),
} as const;

export type VideoAPIFamily = keyof typeof owners;
export type VideoAPIModule<Family extends VideoAPIFamily> = Awaited<ReturnType<(typeof owners)[Family]>>;
export interface VideoAPIDescriptor {
  readonly id: VideoAPIFamily;
  readonly module: string;
  readonly description: string;
  readonly scope: "protocol" | "acquisition" | "render" | "native" | "catalog" | "service";
}

const definitions: readonly [VideoAPIFamily, string, VideoAPIDescriptor["scope"]][] = [
  ["api", "Bun Video API ownership registry", "catalog"],
  ["catalog", "Private SQLite source, asset and qualification catalog", "catalog"],
  ["workers", "Bounded native Bun process job pool", "render"],
  ["workflow", "Unified capture, acquisition and rendering workflow", "render"],
  ["pixel-verify", "Exact decoded RGBA reference frame comparison", "render"],
  ["video-capture", "Complete private HAR resource and request indexing", "acquisition"],
  ["archive-capture", "Bounded public Internet Archive HTTP HAR capture", "acquisition"],
  ["video-dataset", "Curated SQLite queries and JSON, JSONL, SQL or wiki exports", "catalog"],
  ["video-cookies", "Private authorized Crunchyroll cookie selection and HTTP inspection", "acquisition"],
  ["data-site", "Native Bun full-stack curated source and dataset application", "service"],
  ["publish", "Curated dataset and portable catalog publication through Bun Cloudflare R2", "service"],
  ["hls", "HLS manifests, variants and browser playback", "protocol"],
  ["playback", "Browser video lifecycle, bounded recovery and track selection", "protocol"],
  ["dash", "DASH/MPD manifests and browser playback", "protocol"],
  ["har", "Network archive stream discovery", "acquisition"],
  ["bitmovin", "Licensed Bitmovin browser player integration", "protocol"],
  ["crunchyroll", "Isolated Crunchyroll acquisition client", "acquisition"],
  ["crunchyroll-api", "Crunchyroll HTTP API owner", "acquisition"],
  ["crunchyroll-service", "Crunchyroll service composition owner", "service"],
  ["crunchyroll-cli", "Crunchyroll CLI owner", "service"],
  ["crunchyroll-watchlist", "Authorized Crunchyroll watchlist owner", "acquisition"],
  ["frame-theme", "Frame-derived semantic color roles", "render"],
  ["frame-analysis", "Native frame measurements", "native"],
  ["episode-assets", "Episode asset inspection", "acquisition"],
  ["episode-unpack", "Validated episode archive extraction", "acquisition"],
  ["episode-dataset", "Episode dataset contracts", "catalog"],
  ["pixel-svg", "Measured SVG generation", "render"],
  ["shenron-episode", "Shenron episode asset contracts", "catalog"],
  ["oauth", "OAuth PKCE session flows", "service"],
  ["secrets", "Native protected secret storage", "native"],
  ["webgpu", "Bounded GPU compute and browser probes", "native"],
  ["mediabunny", "Media demuxing, muxing and WebCodecs", "protocol"],
  ["ytdlp", "Vendored site extractors through Bun Python", "acquisition"],
  ["pipeline", "Native video ingestion and media pipeline", "native"],
  ["image", "Native frame image transforms", "native"],
  ["formats", "Media format descriptions", "catalog"],
  ["source", "Source normalization and bounded materialization", "acquisition"],
  ["cache", "Crawler source cache", "catalog"],
  ["archive", "Source archive owner", "catalog"],
  ["studio", "React source player and asset library", "render"],
  ["studio-remotion", "React Remotion video composition", "render"],
  ["encode", "Ordered native frame encoding", "render"],
  ["computer", "Browser automation tasks", "service"],
  ["ffmpeg", "Native FFmpeg media owner", "native"],
  ["mpv", "Native libmpv playback owner", "native"],
  ["sdk", "Pinned optional media SDK acquisition owner", "native"],
  ["remotion", "Absorbed Remotion React core", "render"],
  ["remotion-renderer", "Official Remotion renderer", "render"],
  ["hyperframes", "Absorbed HyperFrames composition core", "render"],
  ["hyperframes-engine", "Official HyperFrames rendering engine", "render"],
  ["capabilities", "Explicit provider availability probes", "native"],
  ["mcp", "Bun Video MCP service", "service"],
  ["render-runtime", "Lazy upstream rendering library loaders", "render"],
  ["render-frame", "Served composition frame capture", "render"],
  ["parallel-capture", "Bounded ordered frame worker pool", "render"],
  ["frame-plan", "Validated rational-FPS frame plans", "render"],
  ["remotion-frame", "Native served Remotion frame capture", "render"],
  ["hyperframes-native", "Native served HyperFrames frame capture", "render"],
  ["media", "FilmCraft media jobs: inspect, download, frames, audio, GIF, remux and cuts", "native"],
  ["x-source", "Public X status video source normalization", "acquisition"],
  ["photocraft", "Native image transformation operations shared with frame output", "native"],
  ["m3-video", "Material 3 video: deterministic typography, logo icons and native export", "render"],
  ["watch", "Timestamped frames and transcript of a video, decoded natively without FFmpeg", "native"],
  ["watch-catalogue", "Episode catalogue runs with bounded concurrency and a resumable cache", "catalog"],
  ["watch-shenron", "Original-size PNG frames and the Shenron episode delivery manifest", "catalog"],
  ["video-watch", "Watch jobs recorded as catalog frames, transcripts and job state", "catalog"],
  ["video-verify", "Native render verification against watch reference frames", "render"],
];

export const VIDEO_APIS: readonly VideoAPIDescriptor[] = Object.freeze(
  definitions.map(([id, description, scope]) =>
    Object.freeze({
      id,
      module: [
        "sdk",
        "render-runtime",
        "render-frame",
        "parallel-capture",
        "frame-plan",
        "remotion-frame",
        "hyperframes-native",
        "watch-catalogue",
        "watch-shenron",
        "video-watch",
        "video-verify",
      ].includes(id)
        ? `./src/${id}.ts`
        : `@aphrody/bun-video/${id.replace("remotion-renderer", "remotion/renderer").replace("hyperframes-engine", "hyperframes/engine").replace("crunchyroll-api", "crunchyroll/api").replace("crunchyroll-service", "crunchyroll/service").replace("crunchyroll-cli", "crunchyroll/cli").replace("crunchyroll-watchlist", "crunchyroll/watchlist")}`,
      description,
      scope,
    }),
  ),
);

/** Metadata only: no providers, secrets, Python host or rendering engines are loaded. */
export function describeVideoAPIs(): readonly VideoAPIDescriptor[] {
  return VIDEO_APIS;
}

export async function loadVideoAPI<Family extends VideoAPIFamily>(family: Family): Promise<VideoAPIModule<Family>> {
  if (!Object.hasOwn(owners, family)) throw new TypeError(`Unknown Bun Video API family: ${family}`);
  return (await owners[family]()) as VideoAPIModule<Family>;
}

/** Export names and kinds only; no values, sessions or credentials are serialized. */
export async function inspectVideoAPI(family: VideoAPIFamily) {
  const module = await loadVideoAPI(family);
  return {
    family,
    loaded: true,
    qualification: "module-load-only" as const,
    exports: Object.entries(module)
      .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
      .map(([name, value]) => ({ name, kind: typeof value })),
  };
}
