import { captureNativeWebViewFrames, type NativeWebViewContext } from "./hyperframes-native";
import { frameOperationSignal, validateFramePlan, type FramePlan } from "./frame-plan";
import { prepareRemotionContext, captureRemotionContextFrame } from "./remotion-frame";

export async function* captureCompositionFrames(
  context: NativeWebViewContext,
  input: FramePlan & { frameStride?: number; signal?: AbortSignal },
): AsyncGenerator<{ frame: number; png: Uint8Array }> {
  const plan = validateFramePlan(input);
  const stride = input.frameStride ?? 1;
  if (!Number.isSafeInteger(stride) || stride < 1) throw new RangeError("Invalid frame stride");
  input.signal?.throwIfAborted();
  if (plan.kind === "hyperframes") {
    yield* captureNativeWebViewFrames(context, {
      url: plan.compositionUrl,
      fps: plan.fps,
      startFrame: plan.startFrame,
      endFrame: plan.endFrame,
      frameStride: stride,
      signal: input.signal,
      timeoutMs: plan.timeoutMs,
    });
    return;
  }
  const operationSignal = () => frameOperationSignal(plan.timeoutMs, input.signal);
  await prepareRemotionContext(context, plan.compositionUrl, operationSignal());
  for (let frame = plan.startFrame; frame < plan.endFrame; frame += stride) {
    yield { frame, png: await captureRemotionContextFrame(context, plan.composition!, frame, operationSignal()) };
  }
}
