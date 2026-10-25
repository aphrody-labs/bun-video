/** Unified Bun loader for the absorbed Remotion and HyperFrames code. */
import { loadVideoAPI } from "./video-api";
export { AbsoluteFill, Easing, interpolate } from "../remotion/core/src/index";
export const loadRemotionCore = () => loadVideoAPI("remotion");
export const loadRemotionRenderer = () => loadVideoAPI("remotion-renderer");
export const loadHyperframesCore = () => loadVideoAPI("hyperframes");
export const loadHyperframesEngine = () => loadVideoAPI("hyperframes-engine");
export { generateSpringEaseData, SPRING_PRESETS } from "../hyperframes/parsers/src/gsapParser";
