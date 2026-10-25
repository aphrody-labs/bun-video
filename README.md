# @aphrody/bun-video

[![checks](https://github.com/aphrody-labs/bun/actions/workflows/bun-video-release.yml/badge.svg)](https://github.com/aphrody-labs/bun/actions/workflows/bun-video-release.yml)

Source package for Bun with HLS, DASH/MPD, HAR inspection, Bitmovin integration,
an isolated Crunchyroll client, OAuth PKCE, and native OS secret storage. It
also preserves the Remotion and HyperFrames integration API, using official
version-pinned libraries and package-local native capture adapters.

The optional open-source media toolchain is documented in
[Open source media stack](docs/open-source-media-stack.md): yt-dlp handles
authorized downloads and mpv handles local playback. Their executables remain
caller-owned and are never installed implicitly.

The generated film timeline is the full-screen vertical feed at `/` (and `/shorts`).
The searchable catalogue is available at `/catalog`. The feed can be mounted as
the home page of the same Bun.serve product as the editor, API and labs. Build it
with `scripts/build-showcase.ts`, then set `BUN_VIDEO_SHOWCASE_ROOT` to that versioned output directory. For a
public deployment, configure the showcase Worker’s `BUN_VIDEO_BACKEND_URL` as a
bare HTTPS origin for this Bun.serve application. The Worker keeps the feed and
catalogue static in R2 while forwarding same-origin app, media, API and lab
routes to Bun. Restrict that origin to Cloudflare and set
`BUN_VIDEO_PUBLIC_MODE=1`: only health, the sanitized capability manifest, and
bounded official YouTube search remain public; capture, extraction, cookies,
the media library, workbench and lab APIs require Cloudflare Access identity
headers. Set `BUN_VIDEO_TRUST_CF_ACCESS=1` only when the origin cannot be reached
outside Cloudflare, and keep the server bound to loopback behind its configured
edge proxy. YouTube playback remains in the official IFrame player; media
downloading is not provided by this API.

The source of [Mediabunny](mediabunny/README.md) v1.9.3 is absorbed into the unified package tree and
available through `@aphrody/bun-video/mediabunny`. This export is the media
demuxing, muxing and WebCodecs layer; it does not install a downloader or
desktop player.

```sh
bun add @aphrody/bun-video@next
```

```ts
import { loadRemotionCore, loadHyperframesCore } from "@aphrody/bun-video";
const { interpolate } = await loadRemotionCore();
import { attachVideoHlsPlayback } from "@aphrody/bun-video/hls";
import { createCrunchyrollClient } from "@aphrody/bun-video/crunchyroll";
```

Additional exports: `/dash` (also `/mpd`), `/har`, `/bitmovin`, `/oauth`, `/webgpu`,
`/secrets`, `/mcp`, and `/capabilities`. See the corresponding guides in docs.
For native media ingestion without loading the optional FFmpeg, mpv or GPU SDK
adapters, import `createVideo` from `@aphrody/bun-video/pipeline`:

```ts
import { createVideo } from "@aphrody/bun-video/pipeline";

const video = await createVideo(new Request("https://cdn.example/video.mp4"), {
  signal: AbortSignal.timeout(10_000),
});
const metadata = await video.metadata();
```

HTTP sources are read with a 256 MiB memory limit; failed responses and oversized
streams are cancelled. Local file paths remain handled by `Bun.Video` directly.
`openVideoPipeline` explicitly opens the FFmpeg adapter and loads mpv only when
playback is requested. The root entrypoint loads the native core. Browser
playback, WebGPU, FFmpeg, mpv and React studios use `/hls`, `/playback`, `/webgpu`,
`/ffmpeg`, `/mpv`, `/studio` and `/studio-remotion`, or `loadVideoAPI(family)`.
Rendering helpers use `loadVideoAPI("remotion")` and
`loadVideoAPI("render-runtime")`; `createVideoDataSite` uses `/data-site`.

Loading a library is lazy; native browser capture requires a separately
qualified provider and explicitly authorized URLs. Native encoding requires
an explicit media executable. The MCP media tool additionally expects the
runtime-provided `bun-video:media-runtime` module.

The package ships one Bun executable, `bun-video`. Its subcommands `hls`, `dash`,
`har`, `keychain`, `chrome`, `crunchyroll`, `shortcuts`, `webgpu`, `workers`,
`network`, `site`, `ytdlp`, `capabilities`, `media-probe`, `encode` and `mcp` share
one dispatcher with `remotion` and `hyperframes`, which run the absorbed upstream CLIs.
Their sources and local browser assets are in src, umbrella-src and assets.
Run `bun-video --help` or `bun-video <command> --help` for configuration. Session cookies,
HAR recordings, signed media URLs and OAuth client secrets are local inputs;
they are not shipped in the npm artifact.

## Bun Video web application

The repository web application is served by `src/serve.ts` and composes the native
media library, studio, source pipeline, HLS/DASH labs and composition integrations.
Its optional YouTube discovery endpoint uses the official YouTube Data API and
Google's privacy-enhanced IFrame player; it never extracts YouTube media bytes.
Set `BUN_VIDEO_YOUTUBE_API_KEY` on the server to enable search. Requests are
limited to ten per minute per client. The limiter uses one shared bucket unless
`BUN_VIDEO_TRUST_CF_IP=1` is set; enable that option only when the origin firewall
accepts traffic exclusively from Cloudflare, since it trusts the `CF-Connecting-IP`
header. The server binds to loopback by default.

The web application includes local media and privileged source/pipeline tools.
Before exposing it publicly, deploy it behind the product's authenticated access
layer and restrict the origin; a successful server start or YouTube search does
not qualify a public production deployment.

This prerelease qualifies packaged utilities separately from live content
playback. An OAuth provider configuration, authorized Crunchyroll session,
valid Bitmovin license and supported browser/DRM environment remain caller
requirements. A blob video URL cannot establish the underlying media
protocol. No successful authenticated Crunchyroll playback is claimed by
package publication. See THIRD_PARTY_NOTICES.md for dependency terms.

`/webgpu` runs WGSL compute through either Bun-launched Chromium WebGPU or the precompiled native
wgpu/CUDA provider. The `bun-video webgpu` command supports Linux serverless jobs when a GPU-enabled
ABI 1.5 runtime artifact is installed, and can open the native Windows CEF desktop adapter probe.
This compute interface does not yet route Remotion/HyperFrames WebGPU compositions through the
video frame encoder; see [the WebGPU guide](docs/webgpu.md) for runtime requirements and limits.

## React Video Studio

`VideoStudio` fournit une bibliothèque et un lecteur React natif pour fichiers locaux,
URLs HTTP(S), variantes de qualité, sous-titres, chapitres, reprise de position,
Picture-in-Picture, plein écran, Media Session et inspection yt-dlp :

```tsx
import { VideoStudio } from "@aphrody/bun-video/studio";

export function Player() {
  return (
    <VideoStudio
      storageKey="catalogue"
      assets={[
        {
          id: "episode-1",
          title: "Episode 1",
          src: "https://cdn.example/video.mp4",
          poster: "/poster.jpg",
        },
      ]}
    />
  );
}
```

Les raccourcis `Espace`, `←`, `→` et `M` contrôlent lecture, recherche et son.
Les sources distantes doivent autoriser CORS pour les sous-titres et variantes. Le
callback `onStatus` reçoit `loading`, `ready` ou `failed` pour synchroniser l’interface.

Pour rendre le même asset dans une composition Remotion, utilisez
`StudioRemotionComposition` depuis `@aphrody/bun-video/studio-remotion` :

```tsx
import { StudioRemotionComposition } from "@aphrody/bun-video/studio-remotion";

export const Composition = () => (
  <StudioRemotionComposition asset={asset} startFrom={0} endAt={150} />
);
```

The official Remotion renderer 4.0.534 rejects Bun prerelease versions such as
1.4.4-debug and 1.4.3-aphrody.4 at import: its minimum-version check excludes
prereleases. `loadRemotionRenderer()` preserves that upstream check. The three
other library loaders and package utilities are qualified separately; importing
the renderer or rendering a composition is not claimed for those runtimes.

## Native checks and release

```sh
bun install --cwd packages/bun-video --frozen-lockfile
bun run --cwd packages/bun-video check
bun run --cwd packages/bun-video build:library
bun run --cwd packages/bun-video pack
```

The release build embeds only explicitly qualified absolute media assets. Set
`BUN_VIDEO_NATIVE_EXECUTABLE`, `BUN_VIDEO_FFMPEG`, and `BUN_VIDEO_FFPROBE` before
`build:library`. Credentials, cookies, HAR files and signed URLs never belong in
the package or CI logs. Tags `bun-video-v*` and manual dispatch run the checks,
publish the `next` npm tag with `NPM_TOKEN`, and optionally upload the packed
artifact to Cloudflare R2 with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
and `BUN_VIDEO_R2_BUCKET`.
