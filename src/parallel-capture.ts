import { validateFramePlan, type FramePlan } from "./frame-plan";
import { validateNativePng } from "./hyperframes-native";

export interface CapturedPng {
  frame: number;
  png: Uint8Array;
}
export interface CaptureWorker {
  addEventListener(type: "message" | "error" | "close", listener: (event: any) => void): void;
  postMessage(message: unknown): void;
  terminate(): unknown;
}
export type CaptureWorkerFactory = () => CaptureWorker;

/** Strided workers each keep one frame in flight while output stays ordered. */
export async function* captureParallelFrames(
  input: FramePlan,
  signal?: AbortSignal,
  createWorker: CaptureWorkerFactory = () =>
    new Worker(new URL("./frame-worker.ts", import.meta.url), { type: "module" }),
): AsyncGenerator<CapturedPng> {
  const plan = validateFramePlan(input);
  signal?.throwIfAborted();
  const active = Math.min(plan.workers, plan.endFrame - plan.startFrame);
  const states: {
    worker: CaptureWorker;
    expected: number;
    outstanding: boolean;
    done: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }[] = [];
  const pending = new Map<number, { state: (typeof states)[number]; png: Uint8Array }>();
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const fail = (error: Error) => {
    failure ??= error;
    notify();
  };
  const abort = () => fail(new Error("Video capture aborted", { cause: signal?.reason }));
  const wait = () =>
    new Promise<void>(resolve => {
      wake = resolve;
    });
  const arm = (state: (typeof states)[number]) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(
      () => fail(new Error(`Capture operation timed out awaiting frame ${state.expected}`)),
      plan.timeoutMs,
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let index = 0; index < active; index++) {
      const worker = createWorker();
      const state: (typeof states)[number] = {
        worker,
        expected: plan.startFrame + index,
        outstanding: false,
        done: false,
      };
      states.push(state);
      worker.addEventListener("message", event => {
        const message = event.data;
        if (message?.type === "error") {
          fail(new Error(String(message.message)));
          return;
        }
        if (message?.type === "done") {
          if (state.done || state.outstanding || state.expected < plan.endFrame)
            fail(new Error("Capture worker completed before acknowledging its assigned frames"));
          else {
            state.done = true;
            clearTimeout(state.timer);
            notify();
          }
          return;
        }
        if (message?.type !== "frame") {
          fail(new Error("Unknown capture worker message"));
          return;
        }
        if (
          state.done ||
          state.outstanding ||
          message.frame !== state.expected ||
          message.frame >= plan.endFrame ||
          !(message.png instanceof ArrayBuffer)
        ) {
          fail(new Error("Invalid, duplicate or out-of-order worker frame"));
          return;
        }
        const png = new Uint8Array(message.png);
        try {
          validateNativePng(png, message.frame, plan);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        clearTimeout(state.timer);
        state.outstanding = true;
        pending.set(message.frame, { state, png });
        notify();
      });
      worker.addEventListener("error", event => fail(new Error(event.message ?? "Capture worker error")));
      worker.addEventListener("close", () => {
        if (!state.done) fail(new Error("Capture worker closed before completing its assigned frames"));
      });
      arm(state);
      worker.postMessage({
        type: "capture",
        plan: { ...plan, startFrame: state.expected, frameStride: active },
      });
    }
    for (let frame = plan.startFrame; frame < plan.endFrame; frame++) {
      while (!pending.has(frame)) {
        if (failure) throw failure;
        await wait();
      }
      if (failure) throw failure;
      const item = pending.get(frame)!;
      pending.delete(frame);
      yield { frame, png: item.png };
      if (failure) throw failure;
      item.state.outstanding = false;
      item.state.expected += active;
      arm(item.state);
      item.state.worker.postMessage({ type: "next" });
    }
    while (!states.every(state => state.done)) {
      if (failure) throw failure;
      await wait();
    }
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const state of states) {
      clearTimeout(state.timer);
      state.worker.terminate();
    }
    pending.clear();
  }
}
