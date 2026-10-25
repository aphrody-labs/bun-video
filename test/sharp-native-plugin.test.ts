import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCompositionTarget, sharpNativePlugin } from "../hyperframes/aphrody/sharp-native-plugin";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

for (const arch of ["x64", "arm64"]) {
  for (const libc of ["glibc", "musl"]) {
    test(`native composition selection preserves ${libc}/${arch} asset identities`, () => {
      const target = nativeCompositionTarget("linux", arch, libc);
      expect(target.sharpPlatform).toBe(`linux${libc === "musl" ? "musl" : ""}-${arch}`);
      expect(target.compositorPackage).toBe(`@remotion/compositor-linux-${arch}-${libc === "musl" ? "musl" : "gnu"}`);
      expect(target.executableSuffix).toBe("");
    });
  }
}
test("unknown native ABI and unqualified hosts fail before packaging", () => {
  expect(nativeCompositionTarget("win32", "x64").compositorPackage).toBe("@remotion/compositor-win32-x64-msvc");
  for (const args of [
    ["linux", "x64"],
    ["linux", "arm64", "unknown"],
    ["win32", "arm64"],
    ["darwin", "arm64"],
  ])
    expect(() => nativeCompositionTarget(args[0]!, args[1]!, args[2])).toThrow("unsupported");
});

const nativeHostSupported =
  (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) ||
  (process.platform === "win32" && process.arch === "x64");
test.skipIf(!nativeHostSupported && process.env.BUN_TEST_REQUIRE_NATIVE_COMPOSITION !== "1")(
  "compiled Sharp and Remotion encode and inspect media using embedded native libraries",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bun-remotion-native-"));
    temporary.push(root);
    const { remotionSourcePlugin } = await import("../remotion/.aphrody/standalone-build");
    const { resolveNativeCompositionTarget } = await import("../hyperframes/aphrody/sharp-native-plugin");
    const target = resolveNativeCompositionTarget();
    const entrypoint = join(root, "entry.ts");
    const renderer = join(import.meta.dir, "../remotion/renderer/src");
    const sharpEntry = Bun.resolveSync("sharp", join(import.meta.dir, ".."));
    await Bun.write(
      entrypoint,
      `import sharp from ${JSON.stringify(sharpEntry)};
import {join} from "node:path";
import {dir} from ${JSON.stringify(target.compositorPackage)};
import {getExecutablePath} from ${JSON.stringify(join(renderer, "compositor/get-executable-path.ts"))};
import {getVideoMetadata} from ${JSON.stringify(join(renderer, "get-video-metadata.ts"))};
const image=join(process.cwd(),"frame.png"),video=join(process.cwd(),"video.mp4");
const {data,info}=await sharp({create:{width:2,height:3,channels:4,background:{r:12,g:34,b:56,alpha:1}}}).resize(16,16).png().toBuffer({resolveWithObject:true});
const decoded=await sharp(data).raw().toBuffer();
await Bun.write(image,data);
const ffmpeg=getExecutablePath({type:"ffmpeg",indent:false,logLevel:"error",binariesDirectory:null});
if(ffmpeg!==join(dir,${JSON.stringify("ffmpeg" + target.executableSuffix)}))throw Error("Compositor owner path differs");
const encode=Bun.spawn([ffmpeg,"-hide_banner","-loglevel","error","-i",image,"-frames:v","1","-c:v","libx264","-pix_fmt","yuv420p",video],{stdout:"pipe",stderr:"pipe"});
const [out,err,exit]=await Promise.all([encode.stdout.text(),encode.stderr.text(),encode.exited]);
if(exit!==0)throw Error("Embedded FFmpeg encoding failed: "+err);
const metadata=await getVideoMetadata(video,{logLevel:"error"});
console.log(JSON.stringify({width:metadata.width,height:metadata.height,codec:metadata.codec,duration:metadata.durationInSeconds,encoded:Bun.file(video).size>0,sharpFormat:info.format,png:[...data.subarray(0,8)],pixel:[...decoded.subarray(0,4)]}));
`,
    );
    const executable = join(root, process.platform === "win32" ? "consumer.exe" : "consumer");
    const built = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      plugins: [await remotionSourcePlugin(), await sharpNativePlugin()],
      compile: { outfile: executable, executablePath: process.execPath },
    });
    expect(built.logs.filter(log => log.level === "error").map(log => log.message)).toEqual([]);
    expect(built.success).toBe(true);
    const child = Bun.spawn([executable], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_BE_BUN: "0", NODE_PATH: "" },
      signal: AbortSignal.timeout(15000),
    });
    const [stdout, stderr, code] = await Promise.all([
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.width).toBe(16);
    expect(result.height).toBe(16);
    expect(result.codec).toBe("h264");
    expect(result.duration).toBeGreaterThan(0);
    expect(result.encoded).toBe(true);
    expect(result.sharpFormat).toBe("png");
    expect(result.png).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(result.pixel).toEqual([12, 34, 56, 255]);
    expect(code).toBe(0);
  },
  45000,
);
