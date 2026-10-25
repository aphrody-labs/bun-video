# FilmCraft and the native video engine

Source inspected: [storytold/filmcraft](https://github.com/storytold/filmcraft/tree/71438c627b5cbcfb550526c3971f4d0037733c5c),
revision `71438c627b5cbcfb550526c3971f4d0037733c5c`, version 0.7.2,
MIT OR Apache-2.0. Inspection does not qualify its behavior in Bun Video.

FilmCraft's codecs and containers are implemented in Rust. Its runtime does not
depend on FFmpeg: FFmpeg is an external test oracle. This is an independent
native media engine, including decoding, encoding, editing and composition.
Both its GPU crate and our current native video backend use wgpu 30.

The Bun Video integration must expose this engine directly. Our FFmpeg/libmpv
route remains separately selectable; it must not become a required dependency
of FilmCraft's decode or export paths. An optional frame adapter can connect
the engines when explicitly requested.

| Source                          | Integration target                                                      |
| ------------------------------- | ----------------------------------------------------------------------- |
| `crates/time`                   | Shared rational frame rates, integer timeline ticks and audio alignment |
| `crates/edit`, `crates/project` | Timeline edits and the common studio project model                      |
| `crates/render`, `crates/gpu`   | Shared frame plans, WGSL effects and linear-light composition           |
| `crates/scopes`, `crates/color` | Grading controls and scopes derived from rendered frames                |
| `crates/automation`             | Native editor commands exposed through Bun Video                        |

The GPU source uploads YUV planes and RGBA layers, caches uploads by pixel-buffer
identity, composites into a floating-point accumulator, and compares results
with a CPU reference. Connecting external decoded frames and
Remotion/HyperFrames frame plans requires an explicit adapter; matching the wgpu major
version alone does not establish texture interoperability.

The inspected time model uses 254,016,000,000 ticks per second, with saturating
integer arithmetic and rational conversions. Its fallback for invalid frame
rates must not weaken Bun Video's explicit input validation.

The [upstream architecture and codec documentation](https://github.com/storytold/filmcraft/blob/71438c627b5cbcfb550526c3971f4d0037733c5c/README.md#formats-and-codecs)
states the runtime/test boundary explicitly.

## Rules retained from the upstream engine

The pinned [AGENTS.md](https://github.com/storytold/filmcraft/blob/71438c627b5cbcfb550526c3971f4d0037733c5c/AGENTS.md)
and [CLAUDE.md](https://github.com/storytold/filmcraft/blob/71438c627b5cbcfb550526c3971f4d0037733c5c/CLAUDE.md)
require:

- Pure Rust codecs and containers; FFmpeg/ffprobe only as external test tools.
- Recoverable `Result` errors, checked arithmetic, bounded input allocations,
  bounded traversal and guarded workers. Preserve unwind support.
- OS media FFI confined to the platform boundary, behind safe APIs.
- No UI dependencies below the frontend/platform layer.
- Integer `Tick` time for edits and one command registry for UI, CLI and automation.
- Open assets with attribution; remove ArtCraft trademarks from modified versions
  and import no Adobe artwork.
- Formatting, strict Clippy, tests, layering, assets and WASM gates before delivery.

The FilmCraft build profile must not link, bundle or ship FFmpeg/libmpv. Bun
Video's separately requested native FFI path remains outside that profile.

## What is integrated

Bun Video links the FilmCraft crates natively (`native/src/filmcraft.rs`, feature `filmcraft`,
pinned by git `rev` in `native/Cargo.toml`). Only the decode, container, color, frame and time
crates are linked; the GPU, editor and UI crates are not.

| Operation | Owner |
| --- | --- |
| MP4 and QuickTime probe, bounded sample-table frame sessions, audio windows | FilmCraft ISO base media owner |
| WebM, Matroska, AVI, MPEG-TS and other containers: probe, frames, audio | FilmCraft `MediaSource` (generic session) |
| MP4 to MP4 lossless remux with byte-identical access units | `remux_mp4` (strict) |
| Remux between MP4, MOV, Matroska and WebM without re-encoding | `filmcraft-lib` facade |
| GIF and WAV export | Bun Video, from decoded RGBA and PCM |

The GPU and time source files remain reference material: no GPU composition is wired into
Bun Video yet.
