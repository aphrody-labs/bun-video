import { dirname, isAbsolute, join, resolve } from "path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

export interface PhotoCraftImageTransformOptions {
  /** Qualified, caller-installed Bun OS photocraft-cli. No implicit download. */
  executable: string;
  /** Private scratch directory owned by the caller, outside published artifacts. */
  temporaryDirectory: string;
  timeoutMs?: number;
}

const MAX_BYTES = 32 * 1024 * 1024;

async function diagnostic(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let remaining = 8192;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (remaining > 0) {
        const chunk = value.slice(0, remaining);
        chunks.push(chunk);
        remaining -= chunk.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(8192 - remaining);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder()
    .decode(bytes)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
}

/** Adapt PhotoCraft's real `convert` command to the unified M3 pipeline hook.
 * PhotoCraft retains decoding, color management and flattening ownership;
 * Bun.Image performs the pipeline's final bounded resize and PNG normalization.
 */
export function createPhotoCraftImageTransform(options: PhotoCraftImageTransformOptions) {
  if (!isAbsolute(options.executable) || !isAbsolute(options.temporaryDirectory)) {
    throw new TypeError("PhotoCraft executable and private scratch directory must be absolute");
  }
  const root = resolve(options.temporaryDirectory);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new RangeError("PhotoCraft timeout must be between 1 and 300000 milliseconds");
  }
  return async (bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
      throw new RangeError("PhotoCraft input must contain 1 byte to 32 MiB");
    }
    // Bun has no public mkdir/mkdtemp API. Its filesystem compatibility layer
    // creates an exclusive 0700 job directory without changing global umask.
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, "photocraft-"));
    const input = join(directory, "source.image");
    const output = join(directory, "flattened.png");
    let failed = false;
    try {
      await Bun.write(input, bytes);
      signal?.throwIfAborted();
      const child = Bun.spawn([options.executable, "convert", input, output, "--format", "png"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = diagnostic(child.stderr).catch(() => "");
      let timedOut = false;
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) child.kill();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        const exitCode = await child.exited;
        const detail = await stderr;
        signal?.throwIfAborted();
        if (timedOut) throw new Error("PhotoCraft conversion timed out");
        if (exitCode !== 0)
          throw new Error(`PhotoCraft conversion failed with exit code ${exitCode}${detail ? `: ${detail}` : ""}`);
        const file = Bun.file(output);
        if (!(await file.exists()) || file.size < 1 || file.size > MAX_BYTES) {
          throw new RangeError("PhotoCraft PNG output is missing or exceeds 32 MiB");
        }
        const result = new Uint8Array(await file.arrayBuffer());
        // Reject unexpected converter output before returning it to downstream stages.
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => result[index] === value)) {
          throw new TypeError("PhotoCraft did not produce PNG bytes");
        }
        signal?.throwIfAborted();
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // This random child is the only tree the adapter owns.
      if (dirname(resolve(directory)) !== root) {
        throw new Error("PhotoCraft scratch path escaped its owner");
      }
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if (!failed) throw error;
      }
    }
  };
}

/** SVG import is owned by PhotoCraft's bounded usvg/resvg importer, not Bun.Image. */
export function createPhotoCraftSVGRasterizer(options: PhotoCraftImageTransformOptions) {
  const convert = createPhotoCraftImageTransform(options);
  return async (bytes: Uint8Array, target: { width: number; height: number; signal?: AbortSignal }) => {
    for (const side of [target.width, target.height]) {
      if (!Number.isSafeInteger(side) || side < 1 || side > 4096) {
        throw new RangeError("PhotoCraft SVG target sides must be between 1 and 4096 pixels");
      }
    }
    const png = await convert(bytes, target.signal);
    const result = await new Bun.Image(png, { maxPixels: 4096 * 4096 })
      .resize(target.width, target.height, { fit: "inside" })
      .png()
      .bytes();
    target.signal?.throwIfAborted();
    return result;
  };
}
