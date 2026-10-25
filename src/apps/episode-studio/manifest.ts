export interface EpisodeManifest {
  schemaVersion: number;
  id: string;
  title: string;
  poster?: string;
  source: { file: string; bytes: number; sha256?: string };
  durationSeconds: number;
  fps: { numerator: number; denominator: number };
  width: number;
  height: number;
  frameCount: number;
  video?: { codec?: string; profile?: string; pixelFormat?: string; colorSpace?: string; bitrate?: number };
  audio?: { codec?: string; language?: string; sampleRate?: number; channels?: number; bitrate?: number };
  chapters?: { title: string; start: number; end?: number }[];
  frames?: { directory: string; pattern: string; format: string; count: number; startNumber?: number; status?: string };
  storyboard?: { time: number; file: string }[];
  highlights?: { id: string; title: string; start: number; duration: number; file: string; poster?: string }[];
  characters?: { id: string; name: string; icon: string; firstSeen?: number; description?: string }[];
  subtitles?: { language: string; label: string; file: string; source: string }[];
  compression?: { file: string; codec: string; lossless: boolean; bytes: number; verified: boolean; status?: string };
  package?: {
    manifest: string;
    index: string;
    readme: string;
    checksums: string;
    volumes: { file: string; bytes: number; sha256: string }[];
    status?: string;
  };
  dataset?: {
    manifest: string;
    files: string[];
    previews?: (string | DatasetPreview)[];
  };
  pixelSVG?: {
    manifest: string;
    entries: {
      id: string;
      title: string;
      role: string;
      svg: string;
      referencePNG: string;
      width: number;
      height: number;
      verification?: { exact?: boolean; differingPixels?: number; status?: string };
    }[];
  };
  themes?: { manifest: string; files: string[] };
}

export interface DatasetPreview {
  file: string;
  title: string;
  timeSeconds?: number;
  french?: string;
  japanese?: string | null;
}
export function datasetPreview(item: string | DatasetPreview, fps: EpisodeManifest["fps"]): DatasetPreview {
  if (typeof item !== "string") return item;
  const frame = /frame-(\d+)\./.exec(item);
  return {
    file: item,
    title: frame ? `Frame ${Number(frame[1])}` : "Image retenue",
    ...(frame ? { timeSeconds: ((Number(frame[1]) - 1) * fps.denominator) / fps.numerator } : {}),
  };
}

export function assetURL(file: string): string {
  return `/media/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function frameFile(manifest: EpisodeManifest, index: number): string | undefined {
  const frames = manifest.frames;
  if (!frames || index < 1 || index > frames.count) return;
  return `${frames.directory}/${frames.pattern.replace(/%0?(\d*)d/, (_, width) => String(index).padStart(Number(width) || 1, "0"))}`;
}

export function timestamp(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
