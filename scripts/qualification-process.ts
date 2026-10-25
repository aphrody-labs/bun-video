import { availableParallelism } from "node:os";

export interface QualificationProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

async function capture(stream: ReadableStream<Uint8Array>, stop: () => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const part of stream) {
    length += part.length;
    if (length > MAX_OUTPUT) {
      stop();
      throw new Error("Qualification phase output exceeded its bound");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, length);
}

/** Windows keeps its CPU-limited Job; Linux reuses the SDK's owned process group. */
export async function runQualificationProcess(args: string[], options: QualificationProcessOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new RangeError("Qualification process requires a positive timeout");
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Qualification cancelled"));
  const signal = AbortSignal.any([deadline, cancellation.signal]);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (process.platform === "win32") {
      const { Job, processes } = await import("bun:windows");
      using job = new Job({ killOnClose: true, cpuRate: Math.min(100, 200 / availableParallelism()) });
      const child = job.spawn([process.execPath, "--no-env-file", ...args], {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stop = () => job.terminate();
      signal.addEventListener("abort", stop, { once: true });
      try {
        processes.setAffinity(child, 3);
        if (signal.aborted) stop();
        const [stdout, stderr, code] = await Promise.all([
          capture(child.stdout, stop),
          capture(child.stderr, stop),
          child.exited,
        ]);
        signal.throwIfAborted();
        return { stdout, stderr, code, signal: child.signalCode };
      } finally {
        signal.removeEventListener("abort", stop);
        stop();
        await child.exited;
      }
    }
    const { processes } = await import("@aphrody/bun-runtime-sdk/system");
    // The SDK merges env with its parent; explicitly clear unselected variables.
    const emptyEnv = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]));
    await using child = processes.spawn({
      program: process.execPath,
      args: ["--no-env-file", ...args],
      cwd: options.cwd,
      env: { ...emptyEnv, ...options.env },
      stdio: "capture-lossless",
      maxOutputBytes: MAX_OUTPUT,
    });
    const output = await child.collectOutput({ timeoutMs: options.timeoutMs, signal });
    return {
      stdout: output.stdout,
      stderr: output.stderr,
      code: output.status.exitCode,
      signal: output.status.signal || null,
    };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
