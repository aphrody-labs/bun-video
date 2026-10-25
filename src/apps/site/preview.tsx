import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { applyDynamicColor } from "@aphrody/m3-tokens/dynamic-color";
import "@aphrody/m3-tokens/m3-tokens.css";
import { gsap } from "gsap";
import { resolveAuthoredTimingWindow } from "../../../hyperframes/core/src/runtime/authoredTiming";
import { collection } from "./collection";
import { Artwork } from "./artwork";
import { Player, type PlayerRef } from "../../../remotion/player/src/index";
import { useCurrentFrame } from "../../../remotion/core/src/index";

const params = new URL(location.href).searchParams;
const work = collection.find(item => item.id === params.get("work")) ?? collection[0]!;
const root = createRoot(document.getElementById("root")!);
const state = { frame: 0 };
const player = React.createRef<PlayerRef>();
function RemotionScene() {
  return <Artwork work={work} frame={useCurrentFrame()} />;
}
const render = () =>
  flushSync(() => {
    if (work.engine === "hyperframes") root.render(<Artwork work={work} frame={Math.round(state.frame)} />);
    else if (player.current) player.current.seekTo(Math.round(state.frame));
    else
      root.render(
        <Player
          ref={player}
          component={RemotionScene}
          durationInFrames={work.durationFrames}
          fps={work.fps.num / work.fps.den}
          compositionWidth={work.width}
          compositionHeight={work.height}
          controls={false}
          style={{ width: "100%", height: "100%" }}
        />,
      );
  });
const globals = window as unknown as Record<string, any>;
document.title = `${work.title} — ${work.engine} — Bun Video`;
document.body.style.cssText = "margin:0;width:100vw;height:100vh;overflow:hidden;background:#080f27";
document.getElementById("root")!.style.cssText = "width:100%;height:100%";
applyDynamicColor("#65558f", { dark: true });
const duration = (work.durationFrames * work.fps.den) / work.fps.num;
if (work.engine === "hyperframes") {
  const timing = resolveAuthoredTimingWindow({ start: 0, duration });
  if (!timing?.duration) throw new Error("Invalid authored composition timing");
  const timeline = gsap
    .timeline({ paused: true })
    .fromTo(
      state,
      { frame: 0 },
      { frame: work.durationFrames, duration: timing.duration, ease: "none", onUpdate: render },
    );
  globals.__timelines = { [work.id]: timeline };
  globals.__hf = {
    duration,
    seek(time: number) {
      timeline.seek(Math.max(0, Math.min(duration, time)));
      render();
    },
  };
  document.getElementById("root")!.dataset.compositionId = work.id;
  document.getElementById("root")!.dataset.duration = String(duration);
}
globals.remotion_renderReady = true;
globals.remotion_setFrame = (frame: number) => {
  state.frame = frame;
  render();
};
globals.showcaseSeek = (frame: number) => {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= work.durationFrames)
    throw new RangeError("Frame outside composition");
  if (work.engine === "hyperframes") globals.__hf.seek((frame * work.fps.den) / work.fps.num);
  else globals.remotion_setFrame(frame);
  return { frame, engine: work.engine, width: work.width, height: work.height };
};
render();
globals.showcaseReady = true;
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "showcase-seek") return;
  globals.showcaseSeek(event.data.frame);
});
