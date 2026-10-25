# Native media implementation references

Sources under `vendor` are checked in with exact revisions and archive SHA-256
receipts and preserve their upstream licenses. Reference-only sources are
listed by upstream repository and commit. The running FFI still calls our
compiled C engines.

| Source                                                                                                                      | Role in Bun Video                                            | Starting points                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `vendor/ffmpeg`                                                                                                             | Authoritative native engine and ABI                          | `doc/examples/demux_decode.c`, `hw_decode.c`, `encode_video.c`, `remux.c`, `transcode.c` |
| `vendor/mpv`                                                                                                                | Playback engine, client API and render API                   | `include/mpv/client.h`, `render.h`, `stream_cb.h`, `player/client.c`                     |
| [mpv-player/mpv-examples@e0d1a84](https://github.com/mpv-player/mpv-examples/tree/e0d1a84c99e8c469b58fde31a1541401acfb0eb2) | Official embedding implementations                           | `libmpv/simple`, `libmpv/sdl`, `libmpv/streamcb`, `libmpv/qt_opengl`                     |
| [zmwangx/rust-ffmpeg@9b9c0b9](https://github.com/zmwangx/rust-ffmpeg/tree/9b9c0b9ba061a019d03807d339fcdd85e3ea9c97)         | Typed Rust ownership and codec state transitions             | `examples/dump-frames.rs`, `examples/transcode-audio.rs`, `src/codec`, `src/format`      |
| [kohsine/libmpv2-rs@d7ccfaf](https://github.com/kohsine/libmpv2-rs/tree/d7ccfafff663d7c731d33383f6ec74247c8dd1dc)           | Rust client, events, rendering and custom protocol lifecycle | `examples/events.rs`, `examples/protocol.rs`, `examples/opengl.rs`, `src`                |
| `vendor/libplacebo`                                                                                                         | Native D3D11 renderer and FFmpeg frame mapping               | `src/d3d11`, `src/include/libplacebo/utils/libav.h`                                      |

The selected first-party provider uses registry `ffmpeg-sys-next =9.0.1` and
the qualified SDK selected through `FFMPEG_DIR`. The upstream Rust wrappers
remain references until that replacement passes its native gates; they are
not dependencies of the provider. Optional libav/mpv/GPU features remain off
by default.

Required integration work is native decode/encode through owned codec and
frame contexts, GPU frame interop, typed libmpv event/render APIs, then direct
use by the absorbed Remotion and HyperFrames pipelines. Fetching these sources
does not prove those integrations.
