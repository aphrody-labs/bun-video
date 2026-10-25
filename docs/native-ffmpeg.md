# Native FFmpeg foundation

## Portable Linux SDK factory

The Linux source factory uses `scripts/aphrody/media-sdk-linux.sh` through
`bun run ffmpeg sdk-build-linux` or `bun run libmpv sdk-build-linux`. It accepts
`linux-x64`, `linux-arm64`, `linux-x64-musl`, and `linux-arm64-musl`, reuses the
existing target sysroot, takes the host's `BUN_MEDIA_HEAVY_LOCK` without waiting,
and compiles with two jobs. SDK stages have bounded timeouts.

```sh
BUN_MEDIA_HEAVY_LOCK="$MEDIA_HEAVY_LOCK" \
BUN_MEDIA_ZLIB_PREFIX="$MEDIA_ZLIB_PREFIX" \
  bun run ffmpeg sdk-build-linux linux-x64 "$MEDIA_SOURCE_ROOT" "$MEDIA_OUTPUT"

BUN_MEDIA_HEAVY_LOCK="$MEDIA_HEAVY_LOCK" \
BUN_MEDIA_VULKAN_HEADERS="$MEDIA_VULKAN_HEADERS" \
  bun run libmpv sdk-build-linux linux-x64 "$MEDIA_SOURCE_ROOT" "$MPV_OUTPUT" "$MEDIA_OUTPUT/prefix"
```

Source roots contain the pinned FFmpeg/MPV owners and their recorded dependency
sources. Zlib is Bun's absorbed zlib-rs (`src/zlib_rs`), built as a C static
library by `qualifyZlibNativeSDK` in `scripts/aphrody/native-sdk-factory.ts`;
its prefix holds `lib/libz.a`, `include/`, `lib/pkgconfig/zlib.pc` and the
zlib-rs notice. The MPV profile builds
FreeType, FriBidi, HarfBuzz, libass and libplacebo with GPU backends and system
font discovery disabled. Vulkan headers are required by libplacebo's stubs;
this profile does not link the Vulkan loader. C++ runtime archive sections are
collected during linking so unused newer libc entry points stay outside the
distribution. Source pins, dependency digests and runtime license notices
remain part of the factory receipts.

Before any Linux archive is written, `qualifyLinuxMediaSDK` checks every ELF,
including bundled dependencies: matching architecture and loader, contained
closure, relocatable search paths, and no private libc ABI. GNU artifacts must
require GLIBC 2.17 or older and cannot use newer GNU packed relocations. Musl
artifacts cannot require GNU libc. The factory does not bundle a system libc.

The 2026-10-13 GNU x64 source qualification uses FFmpeg
`7e93014c5bbb61e7c22afebb478bf92f7a08d59a` and MPV
`c3ac7f39514c7f45bc38a18e66887240539ee33c`. Its receipts live under
`factory/artifacts/runtime-release/linux-media-portable-20261013`. CPU/null
playback and API 2.5 are separate from graphics, windowed playback, protected
media and browser qualification. Functional execution on the VPS checks the
new artifacts on the host libc; an ELF floor check does not constitute execution
on an actual GLIBC 2.17 host. The arm64 and musl adapter probes are qualified
with their four sysroots; complete SDK builds for those targets remain pending.

## Selected-frame provider and Bun.Image pipeline

The runtime exposes `Bun.Video` with the same lazy source and worker pipeline
as `Bun.Image`. The optional `bun_runtime/video_native` feature enables its
existing libav provider; GPU and mpv features remain disabled for this path.
`Bun.Video.available` reports whether that provider was compiled into the runtime.
Build with `bun bd --video-native=on` to opt in; standard builds leave it off.

```ts
if (!Bun.Video.available)
  throw new Error("This runtime has no native video provider");
const video = new Bun.Video(Bun.file("/media/input.mp4"));
const metadata = await video.metadata();
const frame = await video.frame(12).resize(320, 180).png().bytes();
await Bun.write("/media/frame.png", frame);
```

Frame timestamps are seconds. Sources are captured lazily, while mutable byte
inputs are snapshotted when an asynchronous operation starts. Resize and PNG,
JPEG or WebP encoding reuse Bun.Image rather than a second image implementation.
Native provider compilation and playback are separate qualification steps.

The native owner in `native/src/libav.rs` exposes `VideoInput::Path` and
`VideoInput::Bytes(Arc<[u8]>)`, `probe_video`, and `decode_video_frame`. Their
cancel-aware variants share an atomic cancellation token with the caller.
The caller runs these operations off the JavaScript thread; the provider does
not turn synchronous FFmpeg calls into promises.

The provider depends only on registry `ffmpeg-sys-next =9.0.1`; it does not link
the high-level Rust wrapper or either vendored Rust fork. Memory sources reuse
the first-party `MemoryInput` AVIO owner. One immutable `Arc<[u8]>` stays alive
without another full source copy. Teardown closes the demuxer, frees the AVIO
buffer/context, then releases that source. Codec names come from
`avcodec_get_name`, avoiding a second exhaustive codec-ID enum.
Selected-frame decoding seeks against the best stream's timestamp base and
flushes decoder/demux state. The decoder uses one thread and enforces dimension,
100000-packet and 100000-frame limits. Memory input is capped at 512 MiB,
`maxPixels` at 268435456, and one RGBA/PNG frame at 256 MiB.
Probing uses at most 128 streams, an 8 MiB probe window and five seconds of
analysis. A shared thirty-second deadline and atomic cancellation are checked
in AVIO callbacks and between codec operations. They do not preempt a codec
call or an arbitrary caller-supplied blocking Rust reader/writer.

The result is one PNG frame with dimensions and its optional presentation
timestamp. PNG encoding reuses `encode_rgba_png`. Bun.Image remains the owner
of subsequent resize and image-format operations. Metadata reports dimensions,
codec and optional duration. This contract does not claim whole-video
transcoding, shared GPU textures, DRM decoding or a default heavyweight FFmpeg
link in Bun.

Provider tests use a synthetic PNG stream and cover exact decoded pixels,
dimension limits, invalid timestamps and cancellation. Runtime integration and
host qualification remain separate gates. Source vendors and license notices
remain until a qualified single-owner replacement is published and dependent
paths are verified.

Official reference: https://www.ffmpeg.org/documentation.html and the Doxygen
API at https://www.ffmpeg.org/doxygen/trunk/index.html. The checked-in headers
in `vendor/ffmpeg` define the exact ABI used here; online trunk can advance.

`@aphrody/bun-video/ffmpeg` exposes typed native symbols for libavutil,
libavcodec, libavformat, libavfilter, libavdevice, libswscale and libswresample.
Pointer arguments are raw native addresses. Struct layouts and callbacks are
not yet exposed as typed Bun objects. This is a partial API binding.

`FFmpeg.open(directory)` validates each library's major ABI and owns its loaded
handles. With no directory it loads libraries beside the executing Bun binary.
Owned inputs, packets and frames are freed before the libraries. `openInput` discovers
stream metadata; `readPacket` distinguishes end-of-file from native errors.
`allocateFrame()` returns a disposable frame with guarded `pointer` and `unref()`
access. Closing the parent invalidates every owned handle. Native symbols also
expose frame and packet references, codec parameters, format iteration, filter
creation, frame scaling and frame resampling. Callers using raw symbols retain
responsibility for objects they allocate themselves.

```ts
import { FFmpeg } from "@aphrody/bun-video/ffmpeg";

using ffmpeg = FFmpeg.open("C:/bun/build/media/bin");
using input = ffmpeg.openInput("C:/media/video.mkv");
using packet = ffmpeg.allocatePacket();
while (ffmpeg.readPacket(input, packet)) {
  // Native codec bindings can consume packet.pointer.
}
```

Run the native FFI ownership and symbol-loading gate with
`BUN_VIDEO_MEDIA_DIR` set to the absolute DLL directory:
`bun bd test packages/bun-video/test/ffmpeg.test.ts`.
Without that explicit artifact directory the native test is skipped.

## Media pipeline

`openInput(url, options?)` passes string options directly to the native demuxer
through an owned `AVDictionary`. For example, network protocols supporting
`rw_timeout` accept its value in microseconds. Protocol-specific support still
depends on FFmpeg; this is not an asynchronous JavaScript cancellation hook.
The dictionary and failed input contexts are released on every error path.
Unconsumed options are rejected instead of silently ignored.

`FFmpeg.openDecoder(name, codecParameters?)` owns an opened native decoder.
The optional parameters pointer must reference valid `AVCodecParameters` from
the matching FFmpeg ABI for the duration of the call; FFmpeg copies them into
the context. `sendPacket(packet)` returns `ok`, `again`, or `eof`. On `again`,
receive pending frames before retrying the same packet. Send `null` to drain
the decoder, receive frames until `eof`, and call `flush()` before restarting
after a seek. `receiveFrame(frame)` reports the same states and clears the
previous frame reference. Disposal releases the codec before unloading its DLL.
Codec configuration and packet/frame native pointers remain directly accessible.

`openEncoder(name, options?, codecParameters?)` uses the same owned codec
context and option dictionary as the decoder. `sendFrame(frame)` and
`receivePacket(packet)` return `ok`, `again`, or `eof`; send `null` to drain.
Use native context options such as `video_size`, `pixel_format` and `time_base`
to configure video encoders. Frames received by the native decoder can be
submitted directly when their dimensions and pixel format match the encoder.
No PNG serialization or FFmpeg subprocess is required between these codec calls.

`openVideoPipeline` opens the normalized media source with the owned FFmpeg
demuxer and exposes it as `pipeline.input`. Closing the pipeline stops its mpv
client and releases the input before unloading FFmpeg. With `playback: true`,
mpv receives the same selected media URL through `loadfile`.

With the native GPU backend enabled, `pipeline.gpuRuntime` retains the SDK GPU
provider and directly exposes its WGSL/CUDA operations. `pipeline.gpu` contains
the adapter report. Closing the pipeline stops mpv, closes the GPU runtime and
releases FFmpeg, including when another cleanup step fails. This compute access
does not establish shared FFmpeg/mpv/wgpu textures. Chromium GPU probing remains
a separate browser API, not this native runtime provider.

`findStream(input, "video" | "audio" | "subtitle")` selects the native best
stream index and throws FFmpeg's error when no matching stream exists.
`seek(input, timestampMicroseconds)` seeks backward to a suitable keyframe
using a signed 64-bit integer timestamp in the global microsecond time base.
Flush attached decoders after seeking; decoding forward establishes the exact
requested frame. Demuxer seeking alone is not frame-accurate rendering.

Direct file paths and native media URLs bypass yt-dlp. Set `ytDlp` options
explicitly to extract a website into a playable URL. Arrays, Blob objects,
Request objects and Response streams use the native custom AVIO adapter through
`FFmpeg.openMemory`. The bridge owns a copy of the bytes, so JavaScript buffer
detachment or collection cannot invalidate its callbacks. Inputs are bounded
to 512 MiB, and response ingestion is also bounded by chunk count and cancellable.
Memory-source playback through mpv still requires its pending custom-stream
adapter and returns an unsupported error.

Build the AVIO bridge with the native crate's `libav` feature. Its shared library
(`bun_video_native.dll` on Windows) must accompany the seven FFmpeg libraries.

## Shared composition capture

The single-frame and worker Remotion paths use the same readiness, frame-seek,
font-readiness and screenshot implementation. Remotion and HyperFrames share
the bounded operation signal and PNG signature validation. Capture forwards
that signal to native navigation, evaluation and screenshot calls; each frame
has one deadline across its operations. Caller cancellation prevents publication
of subsequent frames. Worker acknowledgements still provide backpressure.

The pure context-fixture tests cover ordering, stride validation, cancellation,
renderer errors and non-PNG output. They do not qualify a real browser renderer
or GPU texture transfer. HyperFrames media injection and shader transitions
remain unsupported by this capture adapter.

## libmpv above the FFmpeg foundation

`mpvABI` exports the native client, asynchronous commands, property observation,
hooks, custom read-only stream callbacks and pointer-based render APIs.
`MpvClient.pointer` and `MpvClient.symbols` provide guarded direct access for
integrators; both reject access after disposal. Raw client and render contexts,
callback lifetimes and native node contents remain the caller's responsibility.
Render functions that pass `mpv_render_param` by value require a native bridge
and are not represented as scalar Bun FFI functions.

`MpvClient.commandAsync(requestId, ...arguments)` queues a native command with
an unsigned 64-bit `bigint` identifier. Queue rejection throws immediately;
execution errors arrive in the `command-reply` event's `error` field.
`nextEvent(timeoutSeconds)` copies the event ID, name, error and request ID
before libmpv reuses its event structure. It does not expose event payload
pointers. A zero timeout polls; a positive timeout blocks the calling thread.
Drain events regularly to avoid overflowing the native event queue, and use
unique request identifiers when multiple commands are outstanding.

`bun bd test packages/bun-video/test/mpv.test.ts` uses the same
`BUN_VIDEO_MEDIA_DIR` directory. Its null-output client checks symbol loading
and disposal; it does not qualify on-screen playback or GPU texture sharing.

Build: `bun run ffmpeg build`. Windows uses Clang-CL/MSVC, Git's native Bash
and GNU Make; it does not use WSL. Outputs and headers install in `build/media`.
FFmpeg includes its built-in codecs and Windows D3D11/D3D12 acceleration;
optional external codecs require their own dependencies.

Windows media builds link the zlib-rs SDK statically (`lib/z.lib`, built from
`src/zlib_rs`), enabling PNG and the other codecs requiring zlib. `BUN_MEDIA_JOBS` limits the
native build's parallelism (1..16, default at most 4). Compression support is
required explicitly, so configuration fails if this dependency cannot link.

Qualification on the owner Windows host: the built DLLs opened a generated
FFV1 Matroska fixture and yielded its three packets through Bun FFI. Native
error -22 was decoded through av_strerror. The native Rust libav decoder also
produced three RGBA frames (49,152 bytes) identical to FFmpeg CLI output,
SHA-256 f855642a83b0f29aea59326cbdc0729b340500df1236e0da45ac47be01c94bcf.
Encode, GPU texture sharing and Remotion/HyperFrames integration remain
unqualified.

## Registry bindings replacement

Registry archives checked on 2026-10-13 provide `ffmpeg-next =9.0.0` and
`ffmpeg-sys-next =9.0.1`, built from
[zmwangx/rust-ffmpeg@3751e28](https://github.com/zmwangx/rust-ffmpeg/tree/3751e2800d5d2f0215d69031285aadebac5db8fc)
and
[zmwangx/rust-ffmpeg-sys@ba293c6](https://github.com/zmwangx/rust-ffmpeg-sys/tree/ba293c6ffa4a5f2f745df024c96b54b5c94abd84).
Cargo records their checksums. The published wrapper already includes
`StreamIo`, `from_read_seek` and `input_from_stream_with_interrupt`; moving
those methods into a second implementation is unnecessary.

The former reference snapshot of
[zmwangx/rust-ffmpeg@9b9c0b9](https://github.com/zmwangx/rust-ffmpeg/tree/9b9c0b9ba061a019d03807d339fcdd85e3ea9c97)
carried six local compatibility changes for
FFmpeg codec, pixel/sample format and side-data enums. The published 9.0.0
wrapper does not include those additions. Its conversions use exhaustive
matches; enabling `non-exhaustive-enums` introduces `unimplemented!()` for
unknown values and does not provide a safe replacement. Registry migration
must compile and exercise the chosen SDK's actual headers and libraries.
The sys fork's remaining header change gates CUDA hardware-context bindings
on an actual CUDA header; the registry header uses opaque CUDA stand-ins.

Before qualifying the registry-backed provider, the VPS gate must verify metadata,
selected-frame PNG decoding, cancellation and malformed input against the SDK,
plus the existing memory-input and libav tests. Preserve the current source
until that replacement passes. No registry replacement or vendor deletion is
qualified by this source audit.

The first-party provider now owns the required state transitions directly on
registry sys bindings. It does not need another renamed crate publication or
a high-level enum fallback. The registry crate retains its WTFPL license;
first-party source retains the native package's MIT license.
Cargo features are independent and disabled by default: `libav`, `mpv`, `gpu`.
The mpv byte-stream bridge uses Rust allocations and can compile without libav;
its existing memory-input adapter is present when both features are enabled.

The `libav` build requires an explicit absolute `FFMPEG_DIR` with the SDK
owner's `bun-sdk-receipt.json` and real version headers. The SDK owner validates
that receipt and its file hashes before invoking Cargo; the native build checks
prefix/receipt presence and derives its expected ABI majors from those headers.
Runtime library majors are checked before reading FFmpeg struct fields.
Provider-off builds do not inspect SDK paths. An SDK layout receipt alone does
not qualify the runtime ABI, decoder or Windows DLL loading.
