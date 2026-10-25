export const IMAGE_IMPORT_FORMATS = ["jpeg", "png", "webp", "gif", "bmp", "tiff", "heic", "avif"] as const;
export const IMAGE_EXPORT_FORMATS = ["jpeg", "png", "webp", "heic", "avif"] as const;
export const VIDEO_IMPORT_FORMATS = ["mp4", "mov", "mkv", "webm", "mp3", "wav", "ogg", "m4a", "aac"] as const;
export const VIDEO_EXPORT_FORMATS = ["mp4", "mov", "mkv", "webm", "mp3", "wav", "ogg", "aac"] as const;

export type ImageImportFormat = (typeof IMAGE_IMPORT_FORMATS)[number];
export type ImageExportFormat = (typeof IMAGE_EXPORT_FORMATS)[number];
export type VideoImportFormat = (typeof VIDEO_IMPORT_FORMATS)[number];
export type VideoExportFormat = (typeof VIDEO_EXPORT_FORMATS)[number];

export function canImportImage(format: string): format is ImageImportFormat {
  return (IMAGE_IMPORT_FORMATS as readonly string[]).includes(format.toLowerCase());
}

export function canExportImage(format: string): format is ImageExportFormat {
  return (IMAGE_EXPORT_FORMATS as readonly string[]).includes(format.toLowerCase());
}

export function canImportVideo(format: string): format is VideoImportFormat {
  return (VIDEO_IMPORT_FORMATS as readonly string[]).includes(format.toLowerCase());
}

export function canExportVideo(format: string): format is VideoExportFormat {
  return (VIDEO_EXPORT_FORMATS as readonly string[]).includes(format.toLowerCase());
}
