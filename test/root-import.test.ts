import { expect, test } from "bun:test";

test("root native APIs work with rendering and media extensions denied until explicitly loaded", async () => {
  const root = new URL("../src/index.ts", import.meta.url).href;
  const fixture = new URL("../../../test/js/bun/video/fixture.ts", import.meta.url).href;
  const optional = new URL("../src/ffmpeg.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { plugin } from "bun";
    let deny = true;
    plugin({ name: "isolate native video core", setup(build) {
      build.onResolve({ filter: /(?:^|\\/)(?:remotion|hyperframes)(?:\\/|$)|^(?:react(?:-dom)?(?:\\/|$)|@aphrody\\/bun-runtime-sdk(?:\\/|$))|\\/(?:ffmpeg|mpv|webgpu|studio|studio-remotion)(?:\\.tsx?)?$/ }, args => {
        if (deny) throw new Error("Optional video owner loaded: " + args.path);
      });
    }});
    let hookVerified = false;
    try { await import(${JSON.stringify(optional)}); } catch (error) {
      hookVerified = String(error).includes("Optional video owner loaded:");
    }
    if (!hookVerified) throw new Error("Optional owner isolation was not active");
    const video = await import(${JSON.stringify(root)});
    const { mp4 } = await import(${JSON.stringify(fixture)});
    const bytes = mp4();
    const input = await video.createVideo(new Response(bytes));
    const metadata = await input.metadata();
    const source = await video.loadVideoAPI("source");
    if (source.resolveVideoSource !== video.resolveVideoSource) throw new Error("Source owner was duplicated");
    const families = video.describeVideoAPIs().map(entry => entry.id);
    if (!["remotion", "hyperframes", "ffmpeg", "mpv", "webgpu", "studio"].every(id => families.includes(id)))
      throw new Error("Optional functionality missing from registry");
    deny = false;
    const engine = await video.loadRemotionCore();
    if (engine !== await video.loadVideoAPI("remotion")) throw new Error("Engine owner was duplicated");
    console.log(JSON.stringify({
      width: metadata.width, frameCount: metadata.frameCount, fileBytes: metadata.fileBytes,
      sourceBytes: bytes.length, interpolation: engine.interpolate(5, [0, 10], [0, 100]),
      native: input instanceof Bun.Video,
    }));
  `,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env }, timeout: 10_000, windowsHide: true },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  const result = JSON.parse(stdout);
  expect(result).toEqual({
    width: 64,
    frameCount: 3,
    fileBytes: result.sourceBytes,
    sourceBytes: result.sourceBytes,
    interpolation: 50,
    native: true,
  });
}, 15_000);
