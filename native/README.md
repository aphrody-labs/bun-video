# bun-video native media

The Rust library and command consume ordered PNG frames without holding a video
in memory. Bun owns parallel capture, ordering, cancellation and backpressure.
The Rust process delegates compression to the explicitly configured FFmpeg
distribution; this binary alone does **not** embed FFmpeg or a browser.

```text
BUN_VIDEO_FFMPEG=<absolute ffmpeg executable>
bun-video-native probe
bun-video-native gpu-info
bun-video-native media <absolute input video>
bun-video-native decode <absolute input video>
bun-video-native encode ffv1 30 120 4 <absolute output.mkv>
bun-video-native encode nvenc 30 120 4 <absolute output.mp4> --allow-lossy
```

`encode` reads concatenated PNG images from stdin. It never executes a shell,
never replaces an existing output, and fails when the selected GPU cannot encode
a 256×256 PNG probe frame. `probe` emits JSON lines with encoder and host readiness. A device
probe success establishes encoding capability for that small fixture, not
arbitrary dimensions, sustained performance or browser rendering acceleration.
The crate has no default features. The complete CPU/AVIO recipe selects
`filmcraft,libav,mpv` explicitly. The optional `gpu` feature wires the native
path to the pinned `gpu-video` crate (wgpu 30). On Windows and Linux it uses Vulkan Video and keeps decoded
frames on the GPU for downstream wgpu work. `gpu-info` reports the real adapter,
driver, device class, and hardware decode/encode flags; codec support remains
driver-dependent.
FPS accepts an integer or exact positive rational such as `30000/1001`, capped
at 240 frames per second. The command passes that ratio to FFmpeg unchanged.

FFV1 level 3 in Matroska with BGRA retains RGB and alpha exactly for 8-bit RGBA
input. The integration test decodes two full frames and compares every byte,
including hidden RGB under alpha. Existing source compression losses cannot be
recovered. H264 NVENC, QSV and AMF explicitly require `--allow-lossy`; these modes
discard alpha and convert to YUV420. They are not advertised as lossless.

## Rust integration and qualification

`EncodeOptions::spawn` gives a Rust caller a streaming child and piped stdin.
That `OwnedChild` kills and reaps its child when dropped. Windows commands are
created atomically inside a non-inherited kill-on-close Job Object, covering
descendants even if Bun abruptly terminates the Rust intermediary. This uses the
repository's nightly Windows process attributes API. Linux commands set
`PR_SET_PDEATHSIG(SIGKILL)` before exec and reject a changed parent PID, so the
direct FFmpeg child dies if the spawning Rust thread/process disappears.
Linux parent-death signals are not inherited by arbitrary grandchildren; other
Unix hosts currently provide graceful RAII cleanup only. These are separate
qualification scopes, not interchangeable whole-tree guarantees.
`args` gives a caller a validated literal argv. The optional `libav` feature
integrates registry `ffmpeg-sys-next =9.0.1` through first-party codec/AVIO owners;
it requires an explicit qualified `FFMPEG_DIR`, its SDK receipt and the
matching libav headers, libraries and bindgen toolchain. Encoder registration is
separate from hardware readiness. No root Cargo workspace changes are needed.
`probe_media` returns FFprobe stream/container JSON; set `BUN_VIDEO_FFPROBE` for
the qualified executable. `spawn_decode_rgba`/`decode` streams original-timing
first-video frames as RGBA bytes; dimensions are supplied by `media`, audio is
not emitted by that operation. Both paths require absolute input filenames.

Final integrator gates, serialized through the selected owner's Cargo factory:

```text
cargo check --manifest-path packages/bun-video/native/Cargo.toml
cargo test --manifest-path packages/bun-video/native/Cargo.toml
cargo clippy --manifest-path packages/bun-video/native/Cargo.toml -- -D warnings
cargo test --manifest-path packages/bun-video/native/Cargo.toml -- --ignored
cargo check --manifest-path packages/bun-video/native/Cargo.toml --features libav
```

The last two need qualified FFmpeg and SDK respectively. Use an isolated target
directory under ignored `tmp/bun-video-native`; preserve sccache. Build the CLI
with the same factory's release build. Commit its generated lockfile after
dependency resolution. Workers do not run builds under the repository PLAN.

The local final gate encountered an sccache RPC timeout before rustc startup.
Its isolated retry clears RUSTC_WRAPPER only in the child Cargo environment;
the workstation and repository wrapper configuration remain intact.
The local `clippy.toml` scopes this independent workspace: it retains safety
bans while avoiding runtime-only requirements to link Bun's engine/JSC ABI.
Strict `-D warnings` remains enabled. The pinned pure Rust `png` codec creates
GPU probe fixtures through the same PNG input path used by real captures,
avoiding `lavfi` or raw input requirements in reduced FFmpeg distributions.

## Why this media path

Both frameworks already depend on FFmpeg:
[Remotion binaries](https://www.remotion.dev/docs/options/binaries-directory)
include FFmpeg, ffprobe and its Rust compositor;
[HyperFrames producer](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)
captures browser frames then encodes/mixes with FFmpeg.

[ffmpeg-sys-next](https://crates.io/crates/ffmpeg-sys-next/9.0.1) provides the
registry bindings. Native code uses `avcodec_find_encoder_by_name` and
`avcodec_get_name` directly, without the wrapper's exhaustive Rust ID conversions.
Repository master version and published version can differ. Pinning avoids
guessing SDK compatibility. The process path works without linking an SDK and
shares the already used codec infrastructure. Optional bindings establish a
direct library entry point without requiring a new Rust codec for every format.

[rav1e](https://github.com/xiph/rav1e) is a focused CPU AV1 encoder, not a complete
audio/video demuxer, GPU pipeline or drop-in FFmpeg replacement. It is not added
to the baseline. [FFV1](https://github.com/FFmpeg/FFV1/blob/master/ffv1.md)
provides a specified lossless archival path. No universal fastest codec or GPU
claim is made without comparable host measurements.
