export type StudioMode = "video" | "animation" | "photo";
export interface StudioMedia {
  id: string;
  name: string;
  type: string;
  size: number;
}
export interface StudioClip {
  id: string;
  assetId: string;
  start: number;
  end: number;
}
export interface StudioProject {
  version: 1;
  id: string;
  name: string;
  mode: StudioMode;
  width: number;
  height: number;
  fps: number;
  assets: StudioMedia[];
  clips: StudioClip[];
  title: string;
  titleColor: string;
  background: string;
  titleSize: number;
  photo: { brightness: number; contrast: number; saturation: number; rotation: number };
}
export function createProject(): StudioProject {
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: "Mon premier montage",
    mode: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    assets: [],
    clips: [],
    title: "Un nouveau regard.",
    titleColor: "#ffffff",
    background: "#26394a",
    titleSize: 64,
    photo: { brightness: 100, contrast: 100, saturation: 100, rotation: 0 },
  };
}

/** Project documents carry metadata, never browser-local blob URLs or source bytes. */
export function isProject(value: unknown): value is StudioProject {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<StudioProject>;
  return (
    p.version === 1 &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    ["video", "animation", "photo"].includes(p.mode ?? "") &&
    [p.width, p.height, p.fps, p.titleSize].every(
      v => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 16384,
    ) &&
    typeof p.title === "string" &&
    typeof p.titleColor === "string" &&
    typeof p.background === "string" &&
    Array.isArray(p.assets) &&
    p.assets.length <= 1000 &&
    p.assets.every(
      a =>
        a &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        typeof a.type === "string" &&
        Number.isFinite(a.size),
    ) &&
    Array.isArray(p.clips) &&
    p.clips.length <= 1000 &&
    p.clips.every(
      c =>
        c &&
        typeof c.id === "string" &&
        typeof c.assetId === "string" &&
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start,
    ) &&
    !!p.photo &&
    [p.photo.brightness, p.photo.contrast, p.photo.saturation].every(v => Number.isFinite(v) && v >= 0 && v <= 200) &&
    Number.isFinite(p.photo.rotation) &&
    p.photo.rotation >= 0 &&
    p.photo.rotation <= 270 &&
    p.photo.rotation % 90 === 0
  );
}
