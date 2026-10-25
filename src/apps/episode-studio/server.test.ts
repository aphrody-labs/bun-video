import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteRange, createEpisodeServer } from "./server";
import { assetURL, datasetPreview, frameFile, type EpisodeManifest } from "./manifest";
import { createVideoArchive } from "../../archive";
import { rehydrateEpisodeVolume, type EpisodePackageManifest } from "../../episode-assets";

describe("Atelier épisode : fichiers confinés et lecture vidéo", () => {
  let directory: string;
  let server: Bun.Server<undefined>;
  const manifest: EpisodeManifest = {
    schemaVersion: 1,
    id: "fixture",
    title: "Épisode test",
    source: { file: "source.mp4", bytes: 10 },
    width: 1920,
    height: 1080,
    durationSeconds: 1,
    fps: { numerator: 24000, denominator: 1001 },
    frameCount: 24,
    frames: { directory: "frames", pattern: "frame-%06d.png", format: "png", count: 1 },
    characters: [{ id: "beerus", name: "Beerus", icon: "icons/Beerus étoile.svg" }],
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "bun-video-episode-test-"));
    const episode = join(directory, "episode");
    await mkdir(join(episode, "frames"), { recursive: true });
    await mkdir(join(episode, "icons"));
    await Bun.write(join(episode, "manifest.json"), JSON.stringify(manifest));
    await Bun.write(join(episode, "source.mp4"), "0123456789");
    await Bun.write(join(episode, "frames/frame-000001.png"), "frame-content");
    await Bun.write(join(episode, "frames/frame-000002.png"), "unfinished-frame");
    await Bun.write(join(episode, "icons/Beerus étoile.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await Bun.write(join(episode, "credentials.json"), "protected-fixture");
    await mkdir(join(directory, "outside"));
    await Bun.write(join(directory, "outside/frame-000001.png"), "outside-content");
    await symlink(
      join(directory, "outside"),
      join(episode, "linked-frames"),
      process.platform === "win32" ? "junction" : "dir",
    );
    server = await createEpisodeServer({
      episodeDir: episode,
      port: 0,
      bundle: false,
      analyzeFrame: async ({ data }, signal) => {
        expect(signal.aborted).toBe(false);
        return {
          dominantColor: [data[0]!, data[1]!, data[2]!],
          samples: 16,
          meanLuminance: 42,
          luminanceVariance: 3,
          laplacianVariance: 4,
          edgeEnergy: 5,
          detailScore: 6,
          lowDetail: false,
          elapsedMs: 1,
          computation: "WGSL",
          adapter: { kind: "chromium", info: null, fallback: null },
        };
      },
    });
  });
  afterAll(async () => {
    await server?.stop(true);
    if (directory?.startsWith(join(tmpdir(), "bun-video-episode-test-")))
      await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);
  test("manifeste et source complète", async () => {
    expect(await (await request("/api/manifest")).json()).toEqual(manifest);
    const response = await request("/media/source.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
  });
  test("plage, fin ouverte et suffixe vidéo", async () => {
    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
    ]) {
      const response = await request("/media/source.mp4", { headers: { Range: range! } });
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(contentRange!);
      expect(await response.text()).toBe(expected!);
    }
  });
  test("plages invalides rejetées", async () => {
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=0-1,4-5", "bytes=-0", "bytes=999999999999999999-"]) {
      const response = await request("/media/source.mp4", { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
    }
    expect(byteRange("bytes=-200", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=0-999", 10)).toEqual({ start: 0, end: 9 });
  });
  test("HEAD, téléchargement et méthodes", async () => {
    const head = await request("/media/source.mp4", { method: "HEAD", headers: { Range: "bytes=1-2" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Length")).toBe("2");
    expect(await head.text()).toBe("");
    expect((await request("/media/source.mp4?download")).headers.get("Content-Disposition")).toContain("attachment;");
    expect((await request("/media/source.mp4", { method: "POST" })).status).toBe(405);
  });
  test("seules les images extraites et ressources déclarées sont accessibles", async () => {
    expect(await (await request("/media/frames/frame-000001.png")).text()).toBe("frame-content");
    expect((await request("/media/frames/frame-000002.png")).status).toBe(404);
    expect((await request("/media/credentials.json")).status).toBe(404);
    expect((await request("/media/manifest.json")).status).toBe(404);
    expect((await request(assetURL("icons/Beerus étoile.svg"))).headers.get("Content-Type")).toBe("image/svg+xml");
    expect(frameFile(manifest, 1)).toBe("frames/frame-000001.png");
    expect(frameFile(manifest, 2)).toBeUndefined();
  });
  test("traversée Windows et chemins encodés rejetés", async () => {
    for (const path of [
      "%2e%2e%2fsource.mp4",
      "frames%2f..%2fsource.mp4",
      "%2e%2e%5csource.mp4",
      "C%3a%2fsource.mp4",
      "%00source.mp4",
      "%E0%A4%A",
      "frames%2f%2fframe-000001.png",
    ]) {
      const response = await request(`/media/${path}`);
      expect([400, 404]).toContain(response.status);
    }
  });
  test("jonction sortant du dossier refusée même lorsqu’elle est déclarée", async () => {
    const path = join(directory, "episode/manifest.json");
    await Bun.write(path, JSON.stringify({ ...manifest, frames: { ...manifest.frames, directory: "linked-frames" } }));
    try {
      expect((await request("/media/linked-frames/frame-000001.png")).status).toBe(404);
    } finally {
      await Bun.write(path, JSON.stringify(manifest));
    }
  });
  test("archives et dataset restent limités aux fichiers explicitement déclarés", async () => {
    const episode = join(directory, "episode"),
      path = join(episode, "manifest.json");
    await mkdir(join(episode, "package"));
    await mkdir(join(episode, "dataset"));
    await Bun.write(join(episode, "package/volume-0001.tar.gz"), "archive-fixture");
    await Bun.write(join(episode, "package/SHA256SUMS"), "checksum-fixture");
    await Bun.write(join(episode, "dataset/train.jsonl"), '{"sample":1}\n');
    await Bun.write(join(episode, "dataset/frame-000024.png"), "preview-fixture");
    await Bun.write(join(episode, "dataset/window.wav"), "audio-fixture");
    await Bun.write(
      path,
      JSON.stringify({
        ...manifest,
        package: {
          manifest: "package/manifest.json",
          index: "package/asset-index.json",
          readme: "package/README.md",
          checksums: "package/SHA256SUMS",
          volumes: [{ file: "package/volume-0001.tar.gz", bytes: 15, sha256: "fixture" }],
        },
        dataset: {
          manifest: "dataset/manifest.json",
          files: ["dataset/train.jsonl", "dataset/window.wav"],
          previews: ["dataset/frame-000024.png"],
        },
      }),
    );
    try {
      expect(await (await request("/media/package/volume-0001.tar.gz")).text()).toBe("archive-fixture");
      expect((await request("/media/package/volume-0001.tar.gz")).headers.get("Content-Type")).toBe("application/gzip");
      expect(await (await request("/media/package/SHA256SUMS")).text()).toBe("checksum-fixture");
      expect(await (await request("/media/dataset/train.jsonl")).text()).toBe('{"sample":1}\n');
      expect(await (await request("/media/dataset/frame-000024.png")).text()).toBe("preview-fixture");
      expect((await request("/media/dataset/window.wav", { method: "HEAD" })).headers.get("Content-Type")).toBe(
        "audio/wav",
      );
      expect(datasetPreview("dataset/frame-000024.png", manifest.fps)).toEqual({
        file: "dataset/frame-000024.png",
        title: "Frame 24",
        timeSeconds: (23 * 1001) / 24000,
      });
      expect((await request("/media/package/undeclared.tar.gz")).status).toBe(404);
      expect((await request("/media/dataset/credentials.json")).status).toBe(404);
    } finally {
      await Bun.write(path, JSON.stringify(manifest));
    }
  });
  test("analyse RGBA bornée, méthode et origine confinées", async () => {
    const path = "/api/frame-analysis?width=4&height=4";
    const pixels = new Uint8Array(64);
    pixels.set([25, 50, 75, 255]);
    const response = await request(path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: pixels,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ computation: "WGSL", samples: 16, dominantColor: [25, 50, 75] });
    expect((await request(path)).status).toBe(405);
    expect((await request(path, { method: "POST", body: pixels })).status).toBe(415);
    expect(
      (
        await request(path, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", Origin: "https://foreign.invalid" },
          body: pixels,
        })
      ).status,
    ).toBe(403);
    for (const candidate of ["width=257&height=4", "width=4&height=3", "width=NaN&height=4", "width=4.5&height=4"])
      expect(
        (
          await request(`/api/frame-analysis?${candidate}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: pixels,
          })
        ).status,
      ).toBe(400);
    for (const size of [63, 65])
      expect(
        (
          await request(path, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Uint8Array(size),
          })
        ).status,
      ).toBe(400);
  });
  test("un seul calcul GPU peut occuper le serveur", async () => {
    const entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    const bounded = await createEpisodeServer({
      episodeDir: join(directory, "episode"),
      port: 0,
      bundle: false,
      analyzeFrame: async () => {
        entered.resolve();
        await released.promise;
        return {
          dominantColor: null,
          samples: 0,
          meanLuminance: 0,
          luminanceVariance: 0,
          laplacianVariance: 0,
          edgeEnergy: 0,
          detailScore: 0,
          lowDetail: true,
          elapsedMs: 1,
          computation: "WGSL",
          adapter: { kind: "chromium", info: null, fallback: null },
        };
      },
    });
    const post = () =>
      fetch(new URL("/api/frame-analysis?width=4&height=4", bounded.url), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(64),
      });
    const first = post();
    try {
      await entered.promise;
      expect((await post()).status).toBe(429);
      released.resolve();
      expect((await first).status).toBe(200);
      expect((await post()).status).toBe(200);
    } finally {
      released.resolve();
      await first;
      await bounded.stop(true);
    }
  });
  test("HEAD reste honnête et GET recrée seulement l’archive déclarée avec son SHA original", async () => {
    const root = join(directory, "reconstruct"),
      source = new Uint8Array([4, 5, 6, 7]);
    await mkdir(join(root, "package"), { recursive: true });
    const sha = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const blob = `blobs/${sha(source)}.bin`,
      archive = await createVideoArchive({ [blob]: source }, "tar.gz", { level: 1, mtime: 0 }).bytes();
    const bundle = {
      file: "package/assets-0001.tar.gz",
      bytes: archive.length,
      sha256: sha(archive),
      entries: 1,
      uncompressedBytes: 4,
      compression: "gzip",
      owner: "Bun.Archive",
    } as const;
    const immutable: EpisodePackageManifest = {
      schemaVersion: 1,
      producer: "bun-video",
      episode: {
        id: "fixture",
        title: "Fixture",
        source: {
          file: "source.mp4",
          bytes: 10,
          sha256: "0".repeat(64),
          provider: "Crunchyroll",
          providerEpisodeId: "fixture",
        },
        durationSeconds: 1,
        fps: { numerator: 1, denominator: 1 },
        width: 1,
        height: 1,
        frameCount: 1,
      },
      assets: [
        {
          path: "data.bin",
          bytes: 4,
          sha256: sha(source),
          kind: "receipt",
          mime: "application/octet-stream",
          format: "bin",
          packed: { volume: bundle.file, path: blob },
          reference: {
            provider: "local",
            episodeId: "fixture",
            role: "derivative",
            continuity: "dragon-ball-super-anime",
          },
        },
      ],
      bundles: [bundle],
      completeness: {
        expectedFrames: 1,
        indexedFrames: 1,
        indexedAssets: 1,
        packedAssets: 1,
        imageOwner: "Bun.Image",
        archiveOwner: "Bun.Archive",
        fullyPacked: true,
      },
    };
    await Bun.write(join(root, "data.bin"), source);
    await Bun.write(join(root, "package/manifest.json"), JSON.stringify(immutable));
    await Bun.write(
      join(root, "manifest.json"),
      JSON.stringify({
        ...manifest,
        package: {
          manifest: "package/manifest.json",
          index: "package/index.json",
          readme: "package/README.md",
          checksums: "package/SHA256SUMS",
          volumes: [bundle],
          status: "archives-reconstructible-r2-incomplete",
        },
      }),
    );
    const entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    const rebuilding = await createEpisodeServer({
      episodeDir: root,
      port: 0,
      bundle: false,
      rehydrateVolume: async (...args) => {
        entered.resolve();
        await released.promise;
        return rehydrateEpisodeVolume(...args);
      },
    });
    try {
      const url = new URL(`/media/${bundle.file}`, rebuilding.url);
      expect((await fetch(url, { method: "HEAD" })).status).toBe(404);
      expect(await Bun.file(join(root, bundle.file)).exists()).toBe(false);
      const first = fetch(url);
      await entered.promise;
      expect((await fetch(url)).status).toBe(429);
      released.resolve();
      const response = await first;
      expect(response.status).toBe(200);
      expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(bundle.sha256);
      expect((await fetch(url, { method: "HEAD" })).headers.get("Content-Length")).toBe(String(bundle.bytes));
      const partial = await fetch(url, { headers: { Range: "bytes=1-3" } });
      expect(partial.status).toBe(206);
      expect(new Uint8Array(await partial.arrayBuffer())).toEqual(archive.slice(1, 4));
      expect((await fetch(new URL("/media/package/assets-9999.tar.gz", rebuilding.url))).status).toBe(404);
    } finally {
      released.resolve();
      await rebuilding.stop(true);
    }
  });
});
