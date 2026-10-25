declare module "bun-video:media-runtime" {
  export const mediaAssets: {
    nativeExecutable: string;
    ffmpegExecutable: string;
    ffprobeExecutable: string;
  };
}

declare module "bun-video:catalog-inventory" {
  export const capabilities: import("./video-catalog").VideoCapability[];
  export const providers: import("./video-catalog").VideoProvider[];
}

declare module "bun-video:ytdlp-vendor" {
  export const vendorRoot: string;
  export const inventory: { files: number; bytes: number };
}
