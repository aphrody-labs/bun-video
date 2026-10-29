# Running beside unmodified upstream Bun

Bun Video runs on the official `oven-sh/bun` runtime (pinned and tested with canary
`1.4.4-canary.1`, Bun revision `11c367163a4b`). It uses documented upstream APIs only:

| Need | Upstream API used | Where |
| --- | --- | --- |
| Probe, frame, frames, audio, GIF, remux, HLS | `Bun.spawn` of the caller-owned `ffmpeg`/`ffprobe` | `src/native-video.ts` |
| Frame transforms and encodes (resize, rotate, webp, jpeg, png, avif) | `Bun.Image` | `src/native-video.ts`, `src/image.ts` |
| Raw RGBA8 pixels | `Bun.Image#png().bytes()` plus `node:zlib` inflate | `src/png-decode.ts`, `src/image-compat.ts` |
| Native capture, encode, GPU probe | `Bun.spawn` of the `bun-video-native` binary (`native/`) | `src/ffmpeg.ts`, `src/encode.ts` |
| Browser frame capture, HLS/DASH, HAR, OAuth, WebGPU compute | `Bun.WebView`/CDP, `fetch`, `Bun.serve` | `src/*.ts` |
| Compositions | the unmodified npm packages `remotion` and `@hyperframes/*` | `src/upstream-provenance.ts` |

No `Bun.Video`, `bun:video`, `Bun.Image#rgba`, `bun:python`, `bun:chromium` or other fork-only
API is required. Unmodified Bun has no video API: its own media surface is `Bun.Image`
(still images), `Bun.WebView` and `Bun.Archive`.

## The `Video` owner

```ts
import { Video } from "@aphrody/bun-video/native-video";

if (!Video.available) throw new Error("install FFmpeg/FFprobe or set BUN_VIDEO_FFMPEG / BUN_VIDEO_FFPROBE");
const video = new Video("episode.mp4");
const meta = await video.metadata();
await video.frame(12).extract({ left: 0, top: 0, width: 640, height: 360 }).resize(320).webp().write("f.webp");
const { data } = await video.frame(12).resize(64, 36).rgba();
```

`Video` has the surface of the former fork class (`metadata`, `frame`, `frames`, `audio`, `gif`,
`remux`, `hls`) with these differences:

- The decoder is FFmpeg, not FilmCraft; `Video.decoder` is `"ffmpeg-spawn"`.
- `frames()` seeks once per frame (four at a time), so a batch frame is identical to `frame(t)`.
- `audio()` has no `stream` option (first audio stream).
- In-memory sources are copied to a scratch file; call `close()` or use `using`.
- If a legacy fork runtime still exposes `Bun.Video`, `Video` delegates to it.

`Bun.Image` has no `rgba()` in upstream. `src/image-compat.ts` adds one to the prototype only when
it is missing (a no-op once upstream adds it); `src/png-decode.ts` decodes 8-bit non-interlaced PNG.

## Native binary

`native/` (`bun-video-native`) is its own Cargo workspace and stays a spawned executable:
`probe`, `media`, `decode`, `encode` and `filmcraft-encode` with the `filmcraft`, `libav`, `gpu`
and `mpv` features. It exports a small C ABI (`memory_io.rs`) for a later `bun:ffi` binding.
Replacing the FFmpeg-spawn `Video` by an in-process FilmCraft addon (N-API or `bun:ffi` over
`native/src/filmcraft.rs`) is not done yet.

## Legacy (fork) parts

These need the retired Bun fork (`Bun.Video` with `stream` audio, `bun bd`, `../../../test/harness`,
`bun:windows`, `bun:chromium`) and are not run on upstream Bun: `scripts/episode-*.ts`,
`scripts/build-showcase.ts`, `scripts/qualify-*.ts`, `video-benchmark/local`, and the tests
`bitmovin`, `crunchyroll-har-map`, `episode-assets`, `episode-r2`, `qualification-process`,
`remotion-module-assets`, `sharp-native-plugin`, `m3-video-native`, `shenron-media`.

## Upstream versions (merged 2026-10-29)

| Component | Version | Commit |
| --- | --- | --- |
| mediabunny (absorbed source) | v1.63.0 (was v1.9.3) | `0f80f47e617b576737ffd4ce39a626eb7c7e934e` |
| remotion (absorbed source; npm pin) | v4.0.539 (was 4.0.534) | `e50b41a410933aa807515335d1c04dbba1b8b93f` |
| hyperframes (absorbed source; npm pin) | v0.8.214 (was 0.8.144) | `4719543e972548a261b8354f0a8dada479ae5d93` |
| yt-dlp (absorbed source) | 2026.10.26 (was 2026.08.19) | `f264a6cbd1f630894da0f368df00f8aae50140e0` |
| hls.js | 1.7.4 | npm |
| dashjs | 5.2.1 (current) | npm |

Absorbed sources were merged per file with a three-way merge against the previous pinned upstream
commit, so the Bun-specific edits (n2b) survive; conflicts were resolved to upstream. Not merged:
FilmCraft (`vendor/filmcraft`, pinned `e1ebbf4`) is 517 commits behind `storytold/filmcraft`, whose
matroska/isobmff/bitstream moved to `craft-media` without the colour and display-size remux fields
`filmcraft-lib` uses; `gpu-video` stays at smelter `6637f3d` (upstream `8ccf6d7`) and mpv at `88eb9f2`
(upstream `dc4b285`) until the native build is re-qualified.
