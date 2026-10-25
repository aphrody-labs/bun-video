export type VideoSource = string | URL | Blob | ArrayBuffer | ArrayBufferView | Request | Response;
export const MAX_MEMORY_SOURCE_BYTES = 512 * 1024 * 1024;

export type ResolvedVideoSource =
  | { kind: "remote"; url: string }
  | { kind: "file"; path: string }
  | { kind: "bytes"; data: Blob | ArrayBuffer | Uint8Array };

/** Normalize every supported source shape without copying byte-backed inputs. */
export function resolveVideoSource(source: VideoSource): ResolvedVideoSource {
  if (source instanceof Blob) return { kind: "bytes", data: source };
  if (source instanceof ArrayBuffer) return { kind: "bytes", data: source };
  if (ArrayBuffer.isView(source))
    return { kind: "bytes", data: new Uint8Array(source.buffer, source.byteOffset, source.byteLength) };
  if (source instanceof Request || source instanceof Response) {
    if (!source.body) return { kind: "bytes", data: new Uint8Array() };
    throw new TypeError("ReadableStream sources must be consumed with response.arrayBuffer() before normalization");
  }
  if (typeof source !== "string" && !(source instanceof URL)) throw new TypeError("Unsupported video source shape");
  if (typeof source === "string") {
    if (!source || source.includes("\0")) throw new TypeError("Video source must be nonempty and contain no NUL");
    if (/^[A-Za-z]:[\\/]/.test(source) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source))
      return { kind: "file", path: source };
  }
  const value = source instanceof URL ? source : new URL(source);
  if (value.protocol === "file:") return { kind: "file", path: Bun.fileURLToPath(value) };
  if (
    ["http:", "https:", "rtsp:", "rtsps:", "rtmp:", "rtmps:", "srt:", "udp:", "tcp:", "ftp:", "data:"].includes(
      value.protocol,
    )
  )
    return { kind: "remote", url: value.href };
  throw new TypeError(`Unsupported video source protocol: ${value.protocol}`);
}

export async function materializeVideoSource(
  source: VideoSource,
  signal?: AbortSignal,
  maxBytes = MAX_MEMORY_SOURCE_BYTES,
): Promise<ResolvedVideoSource> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_MEMORY_SOURCE_BYTES)
    throw new RangeError("Media memory limit must be an integer between 0 and 512 MiB");
  const checkLength = (length: number) => {
    if (length > maxBytes) throw new RangeError(`Media memory source exceeds ${maxBytes} bytes`);
  };
  if (source instanceof Request) {
    const response = await fetch(source, { signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Media request failed (${response.status})`);
    }
    return await materializeVideoSource(response, signal, maxBytes);
  }
  if (source instanceof Blob) {
    checkLength(source.size);
    const data = await source.arrayBuffer();
    signal?.throwIfAborted();
    return { kind: "bytes", data };
  }
  if (!(source instanceof Response)) {
    const resolved = resolveVideoSource(source);
    if (resolved.kind === "bytes")
      checkLength(resolved.data instanceof Blob ? resolved.data.size : resolved.data.byteLength);
    return resolved;
  }
  if (!source.ok) {
    await source.body?.cancel().catch(() => {});
    throw new Error(`Media response failed (${source.status})`);
  }
  if (!source.body) return { kind: "bytes", data: new Uint8Array() };
  const reader = source.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    const declaredLength = source.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) checkLength(Number(declaredLength));
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      if (!(value instanceof Uint8Array)) throw new TypeError("Media response must contain binary chunks");
      length += value.byteLength;
      checkLength(length);
      if (chunks.length >= 65536) throw new RangeError("Media memory source exceeds its byte or chunk limit");
      chunks.push(value.slice());
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "bytes", data };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
