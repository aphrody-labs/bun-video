import {
  applyDynamicColor,
  schemeFromSeed,
  type ColorRoleMap,
  type SchemeOptions,
} from "@aphrody/m3-tokens/dynamic-color";

export interface VideoFrameTheme {
  seed: string;
  roles: ColorRoleMap;
  sampledPixels: number;
}

/** Select a real frame colour; M3 alone derives the semantic UI roles. */
export function seedFromRGBA(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 65_536 ||
    pixels.length !== width * height * 4
  )
    throw new RangeError("Frame theme requires 1..65536 RGBA pixels at the declared dimensions");
  const buckets = new Map<number, { count: number; red: number; green: number; blue: number; score: number }>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3]! < 128) continue;
    const red = pixels[offset]!,
      green = pixels[offset + 1]!,
      blue = pixels[offset + 2]!;
    const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, red: 0, green: 0, blue: 0, score: 0 };
      buckets.set(key, bucket);
    }
    const maximum = Math.max(red, green, blue),
      minimum = Math.min(red, green, blue);
    const saturation = maximum ? (maximum - minimum) / maximum : 0;
    const toneWeight = maximum < 24 || minimum > 232 ? 0.08 : 1;
    bucket.count++;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    bucket.score += toneWeight * (0.35 + 0.65 * saturation);
  }
  let selected: { count: number; red: number; green: number; blue: number; score: number } | undefined;
  for (const bucket of buckets.values()) if (!selected || bucket.score > selected.score) selected = bucket;
  if (!selected) throw new Error("Frame theme has no visible pixels");
  return `#${[selected.red, selected.green, selected.blue]
    .map(value =>
      Math.round(value / selected!.count)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function frameThemeFromRGBA(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: SchemeOptions = {},
): VideoFrameTheme {
  const seed = seedFromRGBA(pixels, width, height);
  return { seed, roles: schemeFromSeed(seed, options), sampledPixels: width * height };
}

/** Sample the currently presented video frame with a reusable small canvas. */
export function applyVideoFrameTheme(
  video: HTMLVideoElement,
  options: SchemeOptions & { target?: HTMLElement; canvas?: HTMLCanvasElement; maxDimension?: number } = {},
): VideoFrameTheme | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const maximum = options.maxDimension ?? 64;
  if (!Number.isSafeInteger(maximum) || maximum < 8 || maximum > 256)
    throw new RangeError("Frame theme sample dimension must be 8..256");
  const canvas = options.canvas ?? document.createElement("canvas");
  const ratio = Math.min(1, maximum / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * ratio)),
    height = Math.max(1, Math.round(video.videoHeight * ratio));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Video frame theme requires a 2D canvas");
  context.drawImage(video, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  if (!data.some((value: number, index: number) => index % 4 === 3 && value >= 128)) return null;
  const result = frameThemeFromRGBA(data, width, height, options);
  applyDynamicColor(result.seed, options);
  return result;
}
