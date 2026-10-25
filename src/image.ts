export type BunImageFormat = "jpeg" | "png" | "webp" | "avif" | "heic";

export interface ImageTransformOptions {
  readonly width?: number;
  readonly height?: number;
  readonly format?: BunImageFormat;
  readonly quality?: number;
  readonly maxPixels?: number;
  readonly fit?: "fill" | "inside";
  readonly withoutEnlargement?: boolean;
  readonly autoOrient?: boolean;
}

/** Use Bun.Image for bounded video thumbnails and frame assets. */
export async function transformImage(
  input: string | ArrayBuffer | Uint8Array | Blob,
  options: ImageTransformOptions = {},
): Promise<Uint8Array> {
  const image = new Bun.Image(input, {
    maxPixels: options.maxPixels,
    autoOrient: options.autoOrient ?? true,
  });
  if (options.width !== undefined)
    image.resize(options.width, options.height, {
      fit: options.fit ?? "fill",
      withoutEnlargement: options.withoutEnlargement,
    });
  switch (options.format) {
    case "jpeg":
      image.jpeg(options.quality === undefined ? undefined : { quality: options.quality });
      break;
    case "png":
      image.png();
      break;
    case "webp":
      image.webp(options.quality === undefined ? undefined : { quality: options.quality });
      break;
    case "avif":
      image.avif(options.quality === undefined ? undefined : { quality: options.quality });
      break;
    case "heic":
      image.heic(options.quality === undefined ? undefined : { quality: options.quality });
      break;
  }
  return await image.bytes();
}
