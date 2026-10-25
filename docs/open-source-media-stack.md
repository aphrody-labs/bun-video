# Open source media stack

The stack uses two explicit native owners:

- **yt-dlp** for downloading media and metadata. It is a complete command-line
  downloader with extractors for thousands of sites; Bun Video invokes it only
  when the caller supplies an executable and an output path.
- **mpv** for local playback. It is a cross-platform open-source player and can
  be launched as a supervised process by a desktop integration.

For browser-side demuxing, metadata and WebCodecs pipelines, use the vendored
Mediabunny source through `@aphrody/bun-video/mediabunny`. It remains separate
from yt-dlp and mpv: those tools are external media owners and are not silently
installed by this package.

## Boundary

The downloader and player are optional integrations. `@aphrody/bun-video` does
not bundle third-party executables, bypass DRM, or import browser cookies. The
caller must pass an absolute executable path and an authorized media URL. The
downloaded output stays at the caller-selected path.

Official sources: [yt-dlp](https://github.com/yt-dlp/yt-dlp),
[mpv](https://github.com/mpv-player/mpv), and
[Mediabunny](https://github.com/Vanilagy/mediabunny).
