# Bun Video media pipeline

One package CLI connects yt-dlp acquisition, native Bun.Video inspection, the
bundled media converter and a local, full-screen video timeline. JavaScript and
Python work stays in Aphrody Bun: yt-dlp is vendored and runs through Bun's
`bun:python` bridge; Buv owns the CPython host, and `bun uv` is the Bun-native
environment-management entry point. The pipeline never shells out to Python,
Node, pip, or a standalone yt-dlp executable.

```sh
bunx @aphrody/bun-video media doctor
bunx @aphrody/bun-video media inspect https://www.youtube.com/watch?v=ID
bunx @aphrody/bun-video media download https://www.youtube.com/watch?v=ID ./media/video.mp4
bunx @aphrody/bun-video x inspect https://x.com/account/status/ID
bunx @aphrody/bun-video x download https://x.com/account/status/ID ./media/post.mp4
bunx @aphrody/bun-video media extract-frame ./media/video.mp4 ./media/frame.webp --time 14.5 --width 640 --height 360
bunx @aphrody/bun-video media extract-frames ./media/video.mp4 ./media/frames --start 14 --end 16 --step 0.5 --max-frames 4
bunx @aphrody/bun-video media extract-audio ./media/video.mp4 ./media/audio.wav --start 14 --duration 8 --sample-rate 48000
bunx @aphrody/bun-video media gif ./media/video.mp4 ./media/preview.gif --start 14 --duration 3 --fps 12 --width 480
bunx @aphrody/bun-video media remux ./media/video.mp4 ./media/remux.webm
bunx @aphrody/bun-video media cut ./media/video.mp4 ./media/clip.mp4 --start 14.5 --duration 8
bunx @aphrody/bun-video media compress ./media/clip.mp4 ./media/clip-small.mp4 --crf 25 --preset medium
bunx @aphrody/bun-video media serve --root ./media --port 8787
```

`media download` accepts HTTP(S) URLs supported by yt-dlp, including YouTube,
X status pages, direct files, and compatible HLS/DASH manifests. Downloads are
single-item by default, capped at 2 GiB and 30 minutes unless the caller chooses
lower or higher bounds. Fragment concurrency is capped at four. Progress omits
paths and the returned metadata strips media URLs, headers, cookies, and local
paths. DRM is not bypassed. Extraction support does not prove that a source is
public, reachable, authorized, or decodable.

`media extract-frame`, `extract-frames`, `extract-audio`, `gif`, and `remux` call
the native Bun.Video APIs. They retain the runtime limits: frame batches are
capped at 64 frames and 64 MiB, PCM audio at 30 seconds and 64 MiB, GIFs at five
seconds, 24 fps, 640 pixels and 32 MiB. `media doctor` reports the Bun.Video
provider, CPython host, yt-dlp version, and Buv runtime without running a
download. `media cut` stream-copies a time range; `media compress` transcodes
to H.264/AAC with bounded CRF and preset options. `media serve` binds only to loopback and
serves videos directly from the selected directory. It is a video-only,
scroll-snap timeline: each item fills the viewport, loads on approach, and only
the visible item plays. Video responses support byte ranges for seeking. The
server does not expose upload, arbitrary filesystem paths, or a public listener.

From code, `executeMediaJob()` is the shared operation and
`UnifiedVideoPipeline.media()` forwards to it. X URL normalization is also
available through `XVideoSource` and `normalizeXVideoUrl()`.
