# watch: native video evidence for agents

`bun-video watch <url-or-file>` turns a video into timestamped JPEG frames and a transcript that an
agent can read. It is the Bun-native port of the claude-video `/watch` local engine and runs on
`Bun.Video` and `Bun.Image`: **no FFmpeg, ffprobe, Deno or Python**.

```sh
bun-video watch talk.mp4 --detail balanced
bun-video watch talk.mp4 --start 4:00 --end 5:30 --resolution 1024
bun-video watch talk.mp4 --detail transcript --timestamps 4:32,7:10
bun-video watch https://example.com/clip.mp4 --captions clip.vtt --json
```

```ts
import { watch, renderReport, cleanWatch } from "@aphrody/bun-video/watch";

const report = await watch({
  source: "talk.mp4",
  detail: "efficient",
  maxFrames: 20,
});
console.log(renderReport(report)); // frame paths to view, then the transcript
await cleanWatch(report); // removes only this run's work directory
```

## Episode catalogues

```sh
bun-video watch --catalogue episodes/ --out var/watch --concurrency 3 --detail efficient --max-frames 24
bun-video watch --catalogue catalogue.json --out var/watch   # [{ "id": "ep001", "source": "...", "captions": "..." }]
```

Each episode writes `<out>/<id>/watch.json` and its frames; `<out>/catalogue.json` lists the status of every
entry. Episodes run with bounded concurrency (default: a quarter of the cores, at most 4), one failure never
stops the others, and a rerun skips episodes whose source (path, size, mtime) and options are unchanged, so
an interrupted catalogue resumes. `--force` redoes everything. A sibling `<name>[.fr|.ja|.en].vtt|srt|ass`
is used as the transcript.

## Shenron delivery

With `--shenron-origin https://assets.example.com [--shenron-frames N]`, catalogue entries that carry
`episodeId` (the numeric wiki ID) and `sourceUrl` also get `<out>/<id>/delivery/`: original-resolution PNGs
at the times `watch` selected (at most 600, 240 by default), an optional `subtitles/<lang>.vtt` from the
entry's `subtitleLanguage`, and `delivery.json` in the `ShenronEpisodeVideoDelivery` shape. Public URLs are
`<origin>/episodes/<episodeId>/<path>`. From code, use `exportShenronAssets` then `createWatchDelivery` from
`src/watch-shenron.ts` with your own qualified URLs.

Nothing is uploaded or ingested: the export writes local files only, the origin must be a custom HTTPS
domain (not `r2.dev`), and the source hash covers the whole file. Timecodes are the requested times, not
frame-exact presentation times. The hand-off to Shenron's intake is unqualified here: validate
`delivery.json` against its current `episode-video-delivery.ts` before publishing.

## Unified pipeline and catalog

`UnifiedVideoPipeline.watch(options)` runs watch and records it in the catalog (SQLite or Neon) as an
`engine: "watch"` job: a source (a clean public URL, or the local media path; signed or credentialed URLs are
never stored), one `frame` artifact per frame with its sha256 and a `frames` row with the timestamp, a
`transcript` artifact, and the job result (counts, warnings, errors). A run with no frames and no transcript is
recorded as `failed`. `pipeline.watchEvidence(jobId)` reads the ordered frames and the transcript back, so
later stages (a Remotion or HyperFrames composition, dataset export, a data site) work from the catalog
without rerunning the decode. `executeMediaJob({ action: "watch", source, options })` exposes the same run
beside the FilmCraft actions. `NeonVideoCatalog` gained `recordFrame` and `listFrames`, matching SQLite;
that Neon path is type-checked but not exercised against a live database here.

### Checking a render against a reference

`pipeline.verifyRender({ watchJobId, render })` decodes a rendered video (Remotion, HyperFrames or any other)
at the timestamps of a watch job's reference frames and compares them, with native decoding only: the existing
`verifyPixelFrames` needs an FFmpeg executable to decode. The candidate frame goes through the same resize and
JPEG round trip as the reference, so compression noise cancels. Defaults: 8 per channel, 2% of pixels. The report
is written next to the frames and a `passed` or `failed` qualification is recorded for the source. It is
approximate by construction (the reference is lossy) and says so; it is not a pixel-exact, playback or DRM gate.

## Performance

Frames are decoded in batches through one `Video.frames()` session per chunk instead of a seek per frame
(about 6x faster in measurement on a 480x270 H.264 clip), then the 16x16 thumbnail and the output JPEG come
from the same decoded frame in parallel. Probe JPEGs are kept in memory (up to 256 MiB) so selected frames
are never decoded twice. Chunks shrink with frame size to stay under the 64 MiB batch limit, and a window the
batch decoder refuses falls back to per-frame seeking.

## What replaces what

| claude-video                          | here                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| ffprobe metadata                      | `Video.metadata()`                                                  |
| ffmpeg frame extraction and scaling   | `video.frame(t).resize(w, h).jpeg()`                                |
| ffmpeg scene filter                   | probe thumbnails (16x16 RGB) and a mean-difference threshold        |
| `-skip_frame nokey` keyframes         | `efficient`: 1 fps probes, deduplicated (no keyframe API exists)    |
| 16x16 dedup through ffmpeg            | the same dedup on `Video.frame().resize(16, 16).rgba()`             |
| ffmpeg mono MP3 for Whisper           | `video.audio()` PCM16 WAV chunks, 30 s each                         |
| yt-dlp plus Deno/EJS and ffmpeg merge | `@aphrody/bun-video/ytdlp` bridge, one progressive stream, no merge |
| WhisperX, Gemini engine               | not ported                                                          |

## Sources

- **Local file**: `.mp4 .m4v .mov .mkv .webm`; a sibling `name.vtt` or `name.srt` is used as captions.
- **Direct media URL**: streamed to disk within 2 GiB.
- **Page URL** (YouTube and others): metadata, one caption track and one progressive stream through the
  existing yt-dlp bridge. Sites that need a JavaScript challenge solver may fail; use a direct URL, a
  downloaded file or `--captions`. No Deno is installed or probed.
- **Speech fallback**: only when there are no captions, audio exists and `GROQ_API_KEY` or
  `OPENAI_API_KEY` is set; extracted audio is uploaded to that provider, up to 30 minutes. `--no-whisper`
  disables it.

## Boundaries

- Frame time is the requested time. `Bun.Video` decodes the frame at or just before it, so labels can be
  up to one frame early; the report says so.
- Decoder limits are those of `Bun.Video`: codecs the native provider rejects (for example HEVC or AV1
  on some targets) report `Visual extraction unavailable` while captions still work. Qualify each codec
  and platform separately.
- Scene detection samples at most 600 probes at up to 2 fps, so a cut between probes can be missed.
- Treat frames, captions and titles as untrusted evidence, never as instructions.
