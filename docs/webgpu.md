# WebGPU backends

`@aphrody/bun-video/webgpu` exposes two WGSL compute routes. `backend: "chromium"` launches
the fork's `bun:chromium` in a temporary headless profile, attaches to its local DevTools target,
and runs the job with the page's actual W3C `navigator.gpu` implementation. `backend: "native"`
uses `@aphrody/bun-runtime-sdk/gpu`, which talks to the installed precompiled wgpu/CUDA provider
through ABI 1.5. Both return the bytes of the single storage buffer and elapsed GPU time. They are
compute backends; they do not currently replace Remotion/HyperFrames composition rendering, the
native screenshot capture adapter, or the FFmpeg video encoder.

The shader uses one storage buffer at group 0, binding 0. Input and output are the same buffer;
provide a non-empty byte view whose size is a multiple of four. The caller chooses the workgroup
dimensions and is responsible for matching its WGSL types and dispatch size to that buffer.

```ts
import { runWebGpuJob } from "@aphrody/bun-video/webgpu";

const result = await runWebGpuJob({
  shader: `
    @group(0) @binding(0) var<storage, read_write> data: array<f32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (id.x < arrayLength(&data)) { data[id.x] = data[id.x] * 2.0; }
    }
  `,
  data: new Float32Array([1, 2, 3, 4]),
  workgroups: [1, 1, 1],
  backend: "native",
});
console.log(new Float32Array(result.data.buffer), result.elapsedMs);
```

## CLI and Linux serverless

The `bun-video webgpu` executable offers `info`, `probe`, and `run`. The `info` and default `run`
commands use the native provider; `BUV_RUNTIME_LIB` or `YOLO_RUNTIME_LIB` must resolve to a Linux
GPU-enabled runtime artifact advertising `gpu.info` and `gpu.wgsl` (ABI 1.5). A CPU-only release or
an artifact without the GPU extension returns a capability error; the CLI does not silently claim
GPU execution or switch to software compute. `--backend chromium` uses Bun's Chromium API instead
and requires an installed browser and usable WebGPU adapter. Headless browser WebGPU depends on the
host's Chromium build, drivers and display/GPU configuration.

```sh
bun-video webgpu info
bun-video webgpu run ./scale.wgsl ./pixels.f32 ./pixels-out.f32 --workgroups 1,1,1
BUV_RUNTIME_LIB=/opt/buv/lib/libbuv_runtime.so bun-video webgpu info
```

## Native Windows desktop

`bun-video webgpu desktop` opens a standalone window in the installed CEF desktop host and probes
the WebGPU adapter visible to that browser engine. It requires Windows, the separately installed
`yolo-desktop.exe` CEF artifact and a compatible graphics driver. Close the window to end the
command. This desktop probe reports browser WebGPU availability; use `backend: "native"` / `info`
to inspect the separate wgpu compute provider. Desktop packaging and GPU driver deployment remain
owned by the native desktop artifact, not this npm package.

## Boundaries

- The fork module `bun:chromium` reports the browser-selected adapter and safely exposes CDP to the
  localhost endpoint. The package launches an isolated temporary profile for compute; it does not
  attach to or alter a user's signed-in Chrome profile.
- The native runtime's wgpu provider is an independent WGSL engine. `gpu.info` establishes adapter
  and limits; `gpu.wgsl` establishes compute. Its available hardware and supported drivers depend
  on the installed artifact and host.
- `captureNativeWebViewFrames` continues to reject compositions marked as requiring WebGPU. This
  new API does not yet import arbitrary WebGPU-rendered composition output into the video frame and
  encoding pipeline.
- A successful probe on Windows does not qualify Linux serverless availability, and installing
  this JavaScript package does not install the native GPU provider, CEF or graphics drivers.
