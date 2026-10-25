import { schemeFromSeed, type ColorRoleMap, type SchemeVariant } from "@aphrody/m3-tokens/dynamic-color";
import { EMPHASIZED_WEIGHT, EXPRESSIVE_SPRINGS, TYPE_BASE } from "@aphrody/m3-tokens/expressive";
import { spring } from "../remotion/core/src/spring/index";
import { captureCompositionFrames } from "./render-frame";
import { encodeFilmCraftFrames } from "./encode";
import type { NativeWebViewContext } from "./hyperframes-native";
import type { FramePlan } from "./frame-plan";

export type M3VideoInput =
  | { kind: "text" | "prompt"; text: string }
  | { kind: "image" | "logo"; bytes: Uint8Array; format: "raster" | "svg"; label: string };

export interface M3VideoOptions {
  seed: string;
  dark?: boolean;
  variant?: SchemeVariant;
  width?: number;
  height?: number;
  frames?: number;
  fps?: { num: number; den: number };
  signal?: AbortSignal;
  /** Caller-owned native browser context on a trusted, isolated composition origin. */
  svgContext?: NativeWebViewContext;
  /** Existing PhotoCraft or browser rasterizer; Bun.Image does not decode SVG. No implicit downloads. */
  rasterizeSVG?: (
    svg: Uint8Array,
    options: { width: number; height: number; signal?: AbortSignal },
  ) => Promise<Uint8Array>;
  /** Optional existing PhotoCraft operation, applied before Bun.Image normalization. */
  transformImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
}

export interface M3VideoPlan {
  readonly schemaVersion: 1;
  readonly sourceKind: M3VideoInput["kind"];
  readonly interpretation: "typography" | "image-motion" | "logo-reveal";
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly fps: { num: number; den: number };
  readonly roles: ColorRoleMap;
  readonly motion: { readonly reveal: readonly number[] };
  readonly typography: { readonly weight: number; readonly size: number; readonly lineHeight: number };
  readonly asset?: { readonly dataURL: string; readonly width: number; readonly height: number };
}

const MAX_INPUT = 16 * 1024 * 1024;

function checkBytes(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT)
    throw new RangeError("M3 image input must contain 1 byte to 16 MiB");
}

function textValue(value: string): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 6000)
    throw new RangeError("M3 text must contain 1 to 6000 characters");
  return value.trim();
}

/** Plans typography for prompts; this deterministic operation does not claim AI image generation. */
export async function prepareM3Video(input: M3VideoInput, options: M3VideoOptions): Promise<M3VideoPlan> {
  options.signal?.throwIfAborted();
  if (!/^#[a-f\d]{6}$/i.test(options.seed)) throw new TypeError("M3 seed must be a six-digit hex colour");
  const width = options.width ?? 960,
    height = options.height ?? 540;
  const frames = options.frames ?? 96,
    fps = options.fps ?? { num: 24, den: 1 };
  if (
    ![width, height, frames, fps.num, fps.den].every(value => Number.isSafeInteger(value) && value > 0) ||
    width > 3840 ||
    height > 3840 ||
    frames > 10000 ||
    fps.num > 0xffffffff ||
    fps.den > 0xffffffff ||
    fps.num > fps.den * 240 ||
    width * height * 4 * frames > 256 * 1024 * 1024
  )
    throw new RangeError("M3 plan exceeds the native FilmCraft geometry, rate or 256 MiB frame budget");
  const roles = schemeFromSeed(options.seed, { dark: options.dark ?? true, variant: options.variant ?? "expressive" });
  const spatial = EXPRESSIVE_SPRINGS.default;
  const reveal = Array.from({ length: frames }, (_, frame) =>
    frame === frames - 1
      ? 1
      : Math.min(
          1,
          Math.max(
            0,
            spring({
              frame,
              fps: fps.num / fps.den,
              // M3 tokens specify damping ratio; Remotion expects the physical damping coefficient (mass = 1).
              config: {
                mass: 1,
                stiffness: spatial.stiffness,
                damping: 2 * spatial.damping * Math.sqrt(spatial.stiffness),
              },
            }),
          ),
        ),
  );
  const display = TYPE_BASE["display-large"];
  if (!["text", "prompt", "image", "logo"].includes(input.kind)) throw new TypeError("Unknown M3 input kind");
  const plan: M3VideoPlan = {
    schemaVersion: 1,
    sourceKind: input.kind,
    interpretation: input.kind === "logo" ? "logo-reveal" : input.kind === "image" ? "image-motion" : "typography",
    text: textValue("text" in input ? input.text : input.label),
    width,
    height,
    frames,
    fps: Object.freeze({ ...fps }),
    roles: Object.freeze({ ...roles }),
    motion: Object.freeze({ reveal: Object.freeze(reveal) }),
    typography: Object.freeze({
      weight: EMPHASIZED_WEIGHT["display-large"],
      size: parseFloat(display.size) * 16,
      lineHeight: parseFloat(display.lineHeight) * 16,
    }),
  };
  if ("bytes" in input) {
    checkBytes(input.bytes);
    let bytes: Uint8Array = input.bytes.slice();
    if (input.format === "svg") {
      if (!options.rasterizeSVG && !options.svgContext)
        throw new Error("SVG input requires a PhotoCraft adapter or native browser context");
      bytes = options.rasterizeSVG
        ? await options.rasterizeSVG(bytes, { width, height, signal: options.signal })
        : await rasterizeM3SVG(input.bytes, options.svgContext!, { width, height, signal: options.signal });
      checkBytes(bytes);
    } else if (input.format !== "raster") throw new TypeError("Unknown M3 image format");
    options.signal?.throwIfAborted();
    if (options.transformImage) {
      bytes = await options.transformImage(bytes, options.signal);
      checkBytes(bytes);
    }
    const image = new Bun.Image(bytes, { maxPixels: 4096 * 4096, autoOrient: true })
      .resize(input.kind === "logo" ? 512 : width, input.kind === "logo" ? 512 : height, { fit: "inside" })
      .png();
    const dataURL = await image.dataurl();
    options.signal?.throwIfAborted();
    return Object.freeze({ ...plan, asset: Object.freeze({ dataURL, width: image.width, height: image.height }) });
  }
  return Object.freeze(plan);
}

function xml(value: string) {
  return value.replace(
    /[&<>"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
}

function lines(text: string, limit: number): string[] {
  const result: string[] = [];
  let line = "";
  for (const character of Array.from(text.replace(/\s+/g, " "))) {
    if (Array.from(line).length >= limit) {
      result.push(line);
      line = "";
    }
    line += character;
    if (result.length === 3) break;
  }
  if (line) result.push(line);
  return result;
}

/** Same stateless frame contract can be consumed by React/Remotion or HyperFrames. */
export function m3VideoFrameSVG(plan: M3VideoPlan, frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= plan.frames)
    throw new RangeError("Frame is outside the M3 plan");
  const { width: w, height: h } = plan;
  const role = (name: string) => {
    const value = plan.roles[`--md-sys-color-${name}`];
    if (!/^#[a-f\d]{6}$/i.test(value ?? "")) throw new TypeError(`Invalid M3 colour role: ${name}`);
    return value;
  };
  const reveal = plan.motion.reveal[frame];
  const pad = Math.min(w, h) * 0.085;
  const x = pad,
    y = pad + (1 - reveal) * h * 0.08;
  const cardW = w - pad * 2,
    cardH = h - pad * 2;
  const hasAsset = !!plan.asset;
  const titleX = hasAsset ? w * 0.53 : pad * 1.6;
  const font = Math.min(((plan.typography.size * w) / 960) * (hasAsset ? 0.7 : 1), h * 0.14);
  const title = lines(plan.text, hasAsset ? 17 : 24)
    .map(
      (line, index) =>
        `<tspan x="${titleX}" dy="${index ? (font * plan.typography.lineHeight) / plan.typography.size : 0}">${xml(line)}</tspan>`,
    )
    .join("");
  let asset = "";
  if (plan.asset) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(plan.asset.dataURL))
      throw new TypeError("M3 assets must be normalized PNG data URLs");
    const size = Math.min(w * 0.34, h * 0.58),
      ax = pad * 1.55,
      ay = h / 2 - size / 2;
    const shape = plan.sourceKind === "logo" ? size * (0.27 + 0.23 * reveal) : size * 0.1;
    asset = `<defs><clipPath id="asset"><rect class="m3-icon-shape" x="${ax}" y="${ay}" width="${size}" height="${size}" rx="${shape}"/></clipPath></defs><rect class="m3-icon-shape" x="${ax}" y="${ay}" width="${size}" height="${size}" rx="${shape}" fill="${role("primary-container")}"/><image href="${plan.asset.dataURL}" x="${ax + size * 0.12}" y="${ay + size * 0.12}" width="${size * 0.76}" height="${size * 0.76}" preserveAspectRatio="xMidYMid meet" clip-path="url(#asset)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${xml(plan.text)}"><rect width="${w}" height="${h}" fill="${role("surface")}"/><g id="m3-scene" opacity="${reveal}" transform="translate(0 ${y - pad})"><rect x="${x}" y="${pad}" width="${cardW}" height="${cardH}" rx="${Math.min(w, h) * 0.052}" fill="${role("surface-container-high")}"/>${asset}<text x="${titleX}" y="${h * 0.38}" fill="${role("on-surface")}" font-family="sans-serif" font-size="${font}" font-weight="${plan.typography.weight}">${title}</text><rect id="m3-progress" x="${titleX}" y="${h * 0.77}" width="${w * 0.18 * reveal}" height="${h * 0.012}" rx="${h * 0.006}" fill="${role("primary")}"/></g></svg>`;
}

/** M3 adaptive icon artwork retains the logo; it does not invent or trace a new logo. */
export function m3IconSVG(plan: M3VideoPlan): string {
  if (plan.sourceKind !== "logo" || !plan.asset) throw new TypeError("An M3 icon requires a normalized logo plan");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(plan.asset.dataURL))
    throw new TypeError("M3 icon requires normalized PNG pixels");
  const background = plan.roles["--md-sys-color-primary-container"];
  if (!/^#[a-f\d]{6}$/i.test(background ?? "")) throw new TypeError("Invalid M3 icon colour");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${xml(plan.text)}"><rect width="512" height="512" rx="144" fill="${background}"/><image href="${plan.asset.dataURL}" x="88" y="88" width="336" height="336" preserveAspectRatio="xMidYMid meet"/></svg>`;
}

/** Serve this document at an allowlisted origin; no remote scripts, fonts or resources are loaded. */
export function m3VideoDocument(plan: M3VideoPlan): string {
  const timing = JSON.stringify({
    frames: plan.frames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    reveal: plan.motion.reveal,
    logo: plan.sourceKind === "logo",
  });
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aphrody Video · Material 3</title><style>html,body{margin:0;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style><body><main aria-label="${xml(plan.text)}">${m3VideoFrameSVG(plan, 0)}</main><script>const plan=${timing};window.__hf={duration:plan.frames*plan.fps.den/plan.fps.num,seek(time){const frame=Math.min(plan.frames-1,Math.max(0,Math.floor(time*plan.fps.num/plan.fps.den+1e-7)));const reveal=plan.reveal[frame];const scene=document.getElementById('m3-scene');scene.setAttribute('opacity',String(reveal));scene.setAttribute('transform','translate(0 '+((1-reveal)*plan.height*.08)+')');document.getElementById('m3-progress').setAttribute('width',String(plan.width*.18*reveal));if(plan.logo)for(const node of document.querySelectorAll('.m3-icon-shape'))node.setAttribute('rx',String(Math.min(plan.width*.34,plan.height*.58)*(.27+.23*reveal)));}};window.__hf.seek(0);window.showcaseReady=true;</script></body></html>`;
}

/** Rasterizes inert, self-contained vector logos through the existing native browser context. */
export async function rasterizeM3SVG(
  bytes: Uint8Array,
  context: NativeWebViewContext,
  options: { width: number; height: number; signal?: AbortSignal },
): Promise<Uint8Array> {
  checkBytes(bytes);
  if (![options.width, options.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096))
    throw new RangeError("SVG raster dimensions must be 1 to 4096");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new TypeError("SVG document entities are not supported");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  signal.throwIfAborted();
  const png = await context.evaluate<string>(
    `(async()=>{
    const source=${JSON.stringify(text)}, width=${options.width}, height=${options.height};
    const document=new DOMParser().parseFromString(source,'image/svg+xml');
    const allowed=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','mask','use','title','desc','text','tspan']);
    if(document.documentElement.localName!=='svg'||document.querySelector('parsererror'))throw new Error('Invalid SVG');
    if(document.createTreeWalker(document,64).nextNode())throw new Error('SVG processing instructions are forbidden');
    const nodes=document.querySelectorAll('*');if(nodes.length>20000)throw new Error('SVG exceeds its element budget');
    for(const node of nodes){
      if(node.namespaceURI!=='http://www.w3.org/2000/svg'||!allowed.has(node.localName))throw new Error('Unsupported active or external SVG element');
      for(const attr of node.attributes){
        if(/^on/i.test(attr.name)||attr.localName==='style'||attr.name==='xml:base'||/\\\\|@|expression\\s*\\(/i.test(attr.value))throw new Error('Active SVG attribute');
        if(attr.localName==='href'&&!/^#[a-zA-Z_][\\w:.-]*$/.test(attr.value))throw new Error('External SVG references are forbidden');
        for(const match of attr.value.matchAll(/url\\s*\\(([^)]*)\\)/gi))if(!/^['\"]?#[a-zA-Z_][\\w:.-]*['\"]?$/.test(match[1].trim()))throw new Error('External SVG resources are forbidden');
      }
    }
    const root=document.documentElement;
    root.setAttribute('width',String(width));root.setAttribute('height',String(height));
    const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)],{type:'image/svg+xml'}));
    try{const image=new Image();image.src=url;await image.decode();const canvas=globalThis.document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Native browser canvas unavailable');ctx.drawImage(image,0,0,width,height);return canvas.toDataURL('image/png');}finally{URL.revokeObjectURL(url);}
  })()`,
    { signal },
  );
  signal.throwIfAborted();
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png))
    throw new Error("Native SVG rasterizer did not return PNG");
  const result = new Uint8Array(Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
  checkBytes(result);
  return result;
}

/** Existing capture and native FilmCraft owners perform rendering and encoding, one frame at a time. */
export async function renderM3Video(
  plan: M3VideoPlan,
  options: {
    context: NativeWebViewContext;
    compositionURL: string;
    /** A served Remotion composition may consume the same plan/frame function. */
    engine?: FramePlan["kind"];
    composition?: string;
    nativeExecutable: string;
    output: string;
    signal?: AbortSignal;
  },
) {
  const capturePlan: FramePlan = {
    kind: options.engine ?? "hyperframes",
    compositionUrl: options.compositionURL,
    composition: options.composition,
    fps: plan.fps,
    startFrame: 0,
    endFrame: plan.frames,
    width: plan.width,
    height: plan.height,
    workers: 1,
  };
  async function* rgbaFrames() {
    for await (const frame of captureCompositionFrames(options.context, { ...capturePlan, signal: options.signal })) {
      const pixels = await new Bun.Image(frame.png, { maxPixels: plan.width * plan.height }).rgba();
      if (pixels.width !== plan.width || pixels.height !== plan.height)
        throw new Error("M3 browser viewport does not match the plan");
      yield pixels;
    }
  }
  return encodeFilmCraftFrames(rgbaFrames(), {
    nativeExecutable: options.nativeExecutable,
    output: options.output,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    frames: plan.frames,
    signal: options.signal,
  });
}
