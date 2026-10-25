import { expect, test } from "bun:test";

test("native facade imports and reads media without optional FFI or SDK modules", async () => {
  const pipeline = new URL("../src/pipeline.ts", import.meta.url).href;
  const fixture = new URL("../../../test/js/bun/video/fixture.ts", import.meta.url).href;
  const optional = new URL("../src/ffmpeg.ts", import.meta.url).href;
  const script = `
    import { plugin } from "bun";
    plugin({ name: "reject optional media owners", setup(build) {
      build.onResolve({ filter: /^(bun:ffi$|@aphrody\\/bun-runtime-sdk(?:\\/|$))/ }, args => {
        throw new Error("Optional module loaded: " + args.path);
      });
      build.onResolve({ filter: /\\/(ffmpeg|mpv|sdk)(?:\\.ts)?$/ }, args => {
        throw new Error("Optional media adapter loaded: " + args.path);
      });
    }});
    let blocked = false;
    try { await import(${JSON.stringify(optional)}); } catch (error) {
      blocked = String(error).includes("Optional media adapter loaded:");
    }
    if (!blocked) throw new Error("Optional module isolation hook did not intercept FFmpeg");
    const { createVideo } = await import(${JSON.stringify(pipeline)});
    const { mp4 } = await import(${JSON.stringify(fixture)});
    const bytes = mp4();
    let cancelled = false;
    const oversized = new ReadableStream({ cancel() { cancelled = true; } });
    try {
      await createVideo(new Response(oversized, { headers: { "content-length": String(256 * 1024 * 1024 + 1) } }));
      throw new Error("Oversized source was accepted");
    } catch (error) {
      if (!String(error).includes("exceeds 268435456 bytes") || !cancelled) throw error;
    }
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(bytes); } });
    const video = await createVideo(new Request(server.url));
    const metadata = await video.metadata();
    if (metadata.frameCount !== 3 || metadata.width !== 64 || metadata.fileBytes !== bytes.length)
      throw new Error("Unexpected native metadata " + JSON.stringify(metadata));
    console.log("native-media-without-optional-adapters");
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe("native-media-without-optional-adapters");
  expect(status).toBe(0);
}, 15_000);
