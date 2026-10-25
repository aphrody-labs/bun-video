import { expect, test } from "bun:test";
import manifest from "../src/sdk-manifest.json";
import { mediaSDKHostTarget, mediaSDKTargetFor } from "../src/sdk-platform";
import { mediaSDKPlan, validateSDKAsset } from "../src/sdk";
import { targetFor, type HostPlatform, type HostArch } from "@aphrody/bun-runtime-sdk/target";

const nativeArtifact = Bun.env.BUN_RUNTIME_SDK_TEST_ARTIFACT;
test.skipIf(!nativeArtifact)("media platform matches the hash-verified actual native SDK target", async () => {
  const { loadArtifactAsync } = await import("@aphrody/bun-runtime-sdk/artifact");
  const runtime = await loadArtifactAsync(nativeArtifact!);
  try {
    const target = mediaSDKHostTarget();
    expect(runtime.buildInfo().target).toBe(
      targetFor(
        process.platform as HostPlatform,
        process.arch as HostArch,
        target.startsWith("linux-") ? (target.endsWith("-musl") ? "musl" : "gnu") : undefined,
      ),
    );
  } finally {
    runtime.close();
  }
});

test("media targets distinguish Linux libc and preserve native ARM64 names", () => {
  const cases = [
    [{ platform: "win32", arch: "x64" }, "windows-x64"],
    [{ platform: "win32", arch: "arm64" }, "windows-arm64"],
    [{ platform: "darwin", arch: "x64" }, "darwin-x64"],
    [{ platform: "darwin", arch: "arm64" }, "darwin-arm64"],
    [{ platform: "linux", arch: "x64", glibcVersionRuntime: "2.39" }, "linux-x64"],
    [{ platform: "linux", arch: "arm64", glibcVersionRuntime: "2.39" }, "linux-arm64"],
    [{ platform: "linux", arch: "x64", abi: "musl" }, "linux-x64-musl"],
    [{ platform: "linux", arch: "arm64", abi: "musl" }, "linux-arm64-musl"],
  ] as const;
  for (const [host, target] of cases) expect(mediaSDKTargetFor(host)).toBe(target);
  expect(new Set<string>(cases.map(([, target]) => target))).toEqual(new Set(Object.keys(manifest.targets)));
});

test("media SDK host detection reuses the measured libc owner and never guesses musl", () => {
  expect(() => mediaSDKTargetFor({ platform: "linux", arch: "x64" })).toThrow("could not be qualified");
  expect(() => mediaSDKTargetFor({ platform: "linux", arch: "x64", abi: "musl", glibcVersionRuntime: "2.31" })).toThrow(
    "contradicts",
  );
  expect(
    mediaSDKTargetFor({
      platform: "linux",
      arch: "arm64",
      mappedLibraries: "1000-2000 r-xp 0 00:00 1 /lib/ld-musl-aarch64.so.1\n",
    }),
  ).toBe("linux-arm64-musl");
});

test("media target selection rejects unsupported systems and architectures", () => {
  for (const host of [
    { platform: "freebsd", arch: "x64" },
    { platform: "linux", arch: "ia32" },
    { platform: "win32", arch: "aarch64" },
  ])
    expect(() => mediaSDKTargetFor(host)).toThrow("Unsupported media SDK target");
});

test("host media target is a selected SDK target", () => {
  expect(Object.hasOwn(manifest.targets, mediaSDKHostTarget())).toBe(true);
});

test("all selected SDK sources remain pinned and only natively qualified distributions are published", () => {
  for (const target of Object.keys(manifest.targets) as (keyof typeof manifest.targets)[]) {
    for (const component of ["ffmpeg", "mpv"] as const) {
      const plan = mediaSDKPlan(component, target);
      expect(plan.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
      if (plan.status === "native-sdk-qualified") {
        expect(plan.assets).toHaveLength(1);
        for (const asset of plan.assets) {
          expect(() => validateSDKAsset(asset)).not.toThrow();
          expect(asset.url).toStartWith(
            `https://bun-lib.aphrody.app/media/${component}-${plan.version}-${target}-sdk.zip`,
          );
        }
      } else expect(plan.assets).toHaveLength(0);
      expect(plan.status).toMatch(/qualification|qualified/);
      expect(plan.buildRecipe?.owner).toBe("scripts/aphrody/media-sdk-build.ts");
      expect(plan.buildRecipe?.status).toContain("gates required per target");
      for (const asset of plan.upstreamAssets ?? []) expect(() => validateSDKAsset(asset)).not.toThrow();
    }
    const name = mediaSDKPlan("mpv", target).libraryName;
    expect(name).toBe(
      target.startsWith("windows") ? "libmpv-2.dll" : target.startsWith("darwin") ? "libmpv.2.dylib" : "libmpv.so.2",
    );
  }
  for (const target of ["linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"] as const) {
    expect(mediaSDKPlan("ffmpeg", target).upstreamAssets).toHaveLength(0);
    expect(mediaSDKPlan("mpv", target).upstreamAssets).toHaveLength(0);
  }
});
