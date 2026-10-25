# PhotoCraft and the native image pipeline

The canonical PhotoCraft owner is `aphrody-labs/bun-distribution`, currently
version **0.8.2** in `crates/photocraft-*` (26 crates), `apps/photocraft`,
`apps/photocraft-cli` and `apps/photocraft-web`. The source checkpoint inspected
for this bridge is `dc3d6eda133ded583b0a1044630af49d0a1a6257`. Its MIT/Apache
licenses and notices stay with that owner. Importing a second copy into Bun's
runtime would create divergent codecs, project formats and editor state.

`src/photocraft.ts` connects the installed optional engine to M3 video:

```ts
import { createPhotoCraftImageTransform, createPhotoCraftSVGRasterizer } from "@aphrody/bun-video/photocraft";
import { prepareM3Video } from "@aphrody/bun-video/m3-video";

const transformImage = createPhotoCraftImageTransform({
  executable: "/home/ubuntu/build/out/photocraft/photocraft-cli",
  temporaryDirectory: "/home/ubuntu/build/bun-video/private-scratch",
});
// Pass transformImage to the M3 pipeline's options. The engine converts its
// supported layered/flat input into PNG; Bun.Image normalizes that raster.
```

The adapter invokes the actual source-defined contract
`photocraft-cli convert INPUT OUTPUT --format png`. It accepts bytes rather than
ambient input paths, uses a private random job directory, refuses inputs and
outputs above 32 MiB, imposes a bounded deadline, cancels its child process and
removes its own scratch files. It does not install or download an executable.
This conversion flattens layers; the subsequent Bun.Image terminal normalizes
the raster to the video pipeline's RGBA8 representation.
keep the original `.pcraft`/PSD and its color metadata in private storage.

The source-backed automation alternative is `photocraft-cli serve`: JSON lines
with `{id,method,params}` requests and `{id,ok,result|error}` replies. Its real
methods include `engine.commands`, `engine.execute`, `doc.open`, `doc.place`,
`doc.render`, `doc.save` and `batch`. Native automation belongs to
`photocraft-automation`; an editor bridge must forward these operations instead
of recreating their implementation in JavaScript.

## Browser migration

The existing full editor is already a WASM application:
`apps/photocraft-web/index.html` and `src/web.rs`, backed by the same engine,
document, IO and UI crates. Its build uses the existing `wasm-release` profile,
Trunk, optional HEIF support, eframe WebGPU and a WebGL2 fallback. Preserve
`photocraft_canvas`, IndexedDB brush/preset storage and `.pcraft` project identity
while applying Aphrody visual tokens. The existing preset bridge enforces
per-record and aggregate budgets; do not replace it with localStorage.

Unlike FilmCraft, the inspected PhotoCraft web source does **not** export a
`window.photocraft` engine API. Its only browser entry point starts the editor.
The native JSON-line protocol must not be falsely advertised as a browser API.
Shipping a WASM operation bridge requires exposing the existing `Session` and
command registry in that canonical app, then testing browser import, command,
render, save/reload and cancellation. Serve the resulting immutable artifacts
through the shared Bun static host at `/photo/`; do not rebuild the editor as a
separate JavaScript application or replace unrelated Craft applications.

`Bun.Image` currently handles native raster transforms, RGBA and encoding.
It does not decode SVG. SVG rasterization remains an explicitly supplied
qualified browser/vector-engine stage. `createPhotoCraftSVGRasterizer` uses the
same conversion owner, then bounds and resizes the resulting PNG with
`Bun.Image`. PhotoCraft's `photocraft-io/src/svg.rs` already owns its usvg/resvg
importer, rejects external file/image hrefs, and bounds SVG dimensions, nodes
and inflated input. Reusing that importer avoids a second permissive SVG parser
inside Bun.Image. PhotoCraft conversion capability and
Bun.Image capability require separate proofs; neither implies all formats,
GPU acceleration or successful WASM deployment.
