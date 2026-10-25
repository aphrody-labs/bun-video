import { AbsoluteFill } from "./render-runtime";
import { createRequire } from "node:module";
import type { StudioAsset } from "./studio";

const { OffthreadVideo } = createRequire(import.meta.url)("../remotion/core/src/index") as {
  OffthreadVideo: any;
};

export interface StudioRemotionProps {
  readonly asset: StudioAsset;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly volume?: number;
  readonly playbackRate?: number;
  readonly objectFit?: "contain" | "cover" | "fill";
}

/** Render one studio asset inside a Remotion composition with Bun's native pipeline. */
export function StudioRemotionComposition({
  asset,
  startFrom = 0,
  endAt,
  volume = 1,
  playbackRate = 1,
  objectFit = "contain",
}: StudioRemotionProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo
        src={asset.src}
        startFrom={startFrom}
        endAt={endAt}
        volume={volume}
        playbackRate={playbackRate}
        style={{ width: "100%", height: "100%", objectFit }}
      />
    </AbsoluteFill>
  );
}
