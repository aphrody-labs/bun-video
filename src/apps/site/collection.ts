export type ShowcaseEngine = "remotion" | "hyperframes" | "filmcraft" | "native";
export type Artwork = "orbit" | "type" | "terrain" | "wave" | "grid" | "bloom";
export interface ShowcaseWork {
  id: string;
  title: string;
  description: string;
  engine: ShowcaseEngine;
  artwork: Artwork;
  features: readonly string[];
  durationFrames: number;
  fps: { num: number; den: number };
  width: number;
  height: number;
  preview?: string;
  mediaType?: "image" | "audio";
  video?: string;
  captions?: string;
  seed?: string;
  code?: string;
  sourceRef?: string;
  chapter?: string;
}

type Brief = readonly [string, string, string, Artwork, readonly string[]];
const briefs: readonly Brief[] = [
  [
    "orbital",
    "Orbital",
    "Une chorégraphie de trajectoires et de lumière.",
    "orbit",
    ["interpolation", "easing", "SVG", "rational-fps"],
  ],
  [
    "mot-mouvement",
    "Le mot devient mouvement",
    "Une affiche typographique qui se déploie dans le temps.",
    "type",
    ["typography", "spring", "layering"],
  ],
  [
    "relief",
    "Relief",
    "Des lignes de niveau dessinent un paysage en évolution.",
    "terrain",
    ["paths", "stagger", "deterministic-seek"],
  ],
  [
    "frequences",
    "Fréquences",
    "Un paysage de signaux, composé sans hasard.",
    "wave",
    ["waveform", "procedural", "frame-timing"],
  ],
  [
    "architecture",
    "Architecture du rythme",
    "Des modules géométriques composent une partition visuelle.",
    "grid",
    ["sequences", "transforms", "repetition"],
  ],
  [
    "floraison",
    "Floraison",
    "Une étude de symétrie, de rotation et de profondeur.",
    "bloom",
    ["opacity", "rotation", "compositing"],
  ],
];

/** Each engine gets the same authored scene and cadence for measured comparisons. */
export const collection: readonly ShowcaseWork[] = (["remotion", "hyperframes"] as const).flatMap(engine =>
  briefs.map(([id, title, description, artwork, features]) => ({
    id: `${engine}-${id}`,
    title,
    description,
    engine,
    artwork,
    features,
    durationFrames: 96,
    fps: { num: 24, den: 1 },
    width: 960,
    height: 540,
    chapter: "Composition déterministe",
    sourceRef:
      engine === "remotion"
        ? "packages/bun-video/remotion/core/src/index.ts"
        : "packages/bun-video/hyperframes/core/src/runtime/authoredTiming.ts",
    code:
      engine === "remotion"
        ? "const frame = useCurrentFrame();\nconst phase = spring({ frame, fps: 24 });\nreturn <Artwork frame={frame} />;"
        : "const timeline = gsap.timeline({ paused: true });\ntimeline.to(clock, { frame: 95, duration: 4 });\nwindow.__hf.seek(seconds);",
  })),
);

export interface ShowcaseAsset {
  file: string;
  bytes: number;
  sha256: string;
  mime: string;
}
export interface ShowcaseEvidence {
  id: string;
  status: "passed" | "failed" | "unavailable";
  scope: string;
  detail: string;
  assets: ShowcaseAsset[];
  measurements?: Record<string, unknown>;
}
export interface ShowcaseManifest {
  schema: "bun-video/showcase/v1";
  generatedAt: string;
  sourceRevision: string;
  runtime: { version: string; revision: string; platform: string };
  works: Array<ShowcaseWork & { poster?: string; frames?: string[]; evidence: string[] }>;
  evidence: ShowcaseEvidence[];
  apis: Array<{ id: string; description: string; scope: string }>;
}
