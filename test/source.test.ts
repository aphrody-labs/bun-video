import { expect, test } from "bun:test";
import { materializeVideoSource } from "../src/source";

test("memory limits apply to every binary input and preserve view boundaries", async () => {
  const backing = new Uint8Array([9, 1, 2, 9]);
  const view = backing.subarray(1, 3);
  for (const source of [view, new DataView(backing.buffer, 1, 2), view.slice().buffer, new Blob([view])]) {
    const result = await materializeVideoSource(source, undefined, 2);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") throw new Error("Expected bytes");
    const bytes =
      result.data instanceof Blob
        ? new Uint8Array(await result.data.arrayBuffer())
        : result.data instanceof ArrayBuffer
          ? new Uint8Array(result.data)
          : result.data;
    expect(Array.from(bytes)).toEqual([1, 2]);
    await expect(materializeVideoSource(source, undefined, 1)).rejects.toThrow("exceeds 1 bytes");
  }
  for (const limit of [-1, NaN, Infinity, 1.5, 512 * 1024 * 1024 + 1])
    await expect(materializeVideoSource(view, undefined, limit)).rejects.toThrow("Media memory limit");
  expect(await materializeVideoSource(new Uint8Array(), undefined, 0)).toEqual({
    kind: "bytes",
    data: new Uint8Array(),
  });
});

test("stream limits count actual bytes and cancel oversized or failed HTTP responses", async () => {
  for (const headers of [undefined, { "content-length": "1" }, { "content-length": "invalid" }]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(materializeVideoSource(new Response(stream, { headers }), undefined, 2)).rejects.toThrow(
      "exceeds 2 bytes",
    );
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  }
  for (const options of [{ headers: { "content-length": "3" } }, { status: 403 }]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(materializeVideoSource(new Response(stream, options), undefined, 2)).rejects.toThrow(
      options.status ? "Media response failed (403)" : "exceeds 2 bytes",
    );
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  }
  expect(await materializeVideoSource(new Response(new Uint8Array([1, 2])), undefined, 2)).toEqual({
    kind: "bytes",
    data: new Uint8Array([1, 2]),
  });
});

test("cancellation settles a pending stream read and releases its reader", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      started.resolve();
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = materializeVideoSource(new Response(stream), controller.signal, 2);
  await started.promise;
  controller.abort(new Error("stop ingestion"));
  await expect(result).rejects.toThrow("stop ingestion");
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("Request ingestion forwards the byte limit and rejects HTTP errors", async () => {
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/missing"
        ? new Response("missing", { status: 404 })
        : new Response(new Uint8Array([1, 2, 3]));
    },
  });
  await expect(materializeVideoSource(new Request(server.url), undefined, 2)).rejects.toThrow("exceeds 2 bytes");
  await expect(materializeVideoSource(new Request(new URL("missing", server.url)))).rejects.toThrow(
    "Media request failed (404)",
  );
});
