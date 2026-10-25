# Material 3 video

`@aphrody/bun-video/m3-video` is the optional Material 3 extension. It uses the
existing `@aphrody/m3-tokens` colour owner, Bun.Image, browser frame capture and
the native FilmCraft encoder. Install the declared M3 peer dependency when using
this entry point. The main video entry does not require M3.

```ts
import { prepareM3Video, m3VideoDocument, renderM3Video } from "@aphrody/bun-video/m3-video";

const plan = await prepareM3Video(
  { kind: "prompt", text: "One runtime. Native media. Aphrody." },
  { seed: "#7850a8", width: 960, height: 540, frames: 96 },
);
const html = m3VideoDocument(plan);
// Serve html at a trusted composition URL, using the existing Bun.serve owner.
// Set the caller-owned browser viewport to exactly 960 × 540.
await renderM3Video(plan, {
  context, compositionURL, nativeExecutable, output,
});
```

Text and prompts produce deterministic animated typography; this path does not
pretend to generate AI footage. Image and logo inputs accept bounded raster
bytes. SVG inputs use `svgContext`, an existing native browser context, or an
explicit `rasterizeSVG` adapter from PhotoCraft. Built-in browser rasterization
rejects active elements, document entities and external resource references.
An optional `transformImage` operation can reuse PhotoCraft before Bun.Image
normalizes the asset into PNG. No implicit network fetch or tool installation
occurs. Bun.Image itself does not decode SVG.

`m3IconSVG(plan)` creates a 512-pixel M3 container around a normalized logo,
preserving the original mark. To obtain PNG, pass that SVG through
`rasterizeM3SVG`, then use Bun.Image for PNG/WebP variants. This is composition,
not vector tracing or semantic logo redesign.

`m3VideoFrameSVG(plan, frame)` is a pure frame function usable in an existing
React/Remotion composition. The generated document implements the existing
HyperFrames seek contract. A served Remotion composition uses the same plan
with `renderM3Video`'s `engine: "remotion"` and composition ID. The caller owns
the browser origin, viewport, lifetime and served assets.

Exports stream one decoded RGBA frame at a time to the existing native H.264
encoder. The 256 MiB cumulative input budget permits the default 960 × 540 × 96
frames at 24 fps (four seconds). This export is lossy and contains no synthesized
audio. Native Image, browser capture, FilmCraft encoding and the served Remotion
composition each require qualification on the deployment host.
