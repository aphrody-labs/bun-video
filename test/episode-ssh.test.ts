import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveRelayBatches,
  archiveOutputPath,
  assertEpisodeDeliveryScope,
  failedSSHTransferStatus,
  markSSHTransferFailed,
  parseOwnerReceiptSequence,
  qualifiedOwnerReceipt,
  relayPath,
  releaseQualifiedRehydratedArchive,
} from "../scripts/episode-ssh";
import type { EpisodePackageManifest } from "../src/episode-assets";

test("an exited SSH sender records terminal failure without losing qualified receipts", async () => {
  const prefix = join(tmpdir(), "bun-video-ssh-terminal-");
  const root = await mkdtemp(prefix);
  if (!resolve(root).startsWith(resolve(prefix))) throw new Error("Unsafe fixture cleanup namespace");
  try {
    await mkdir(join(root, ".r2"));
    const status = {
      schema: "bun-video/r2-transfer-status/v1" as const,
      sourceSHA: "a".repeat(64),
      sourceSHA256: "a".repeat(64),
      state: "running" as const,
      finishedAt: null,
      transport: "ssh" as const,
      updatedAt: "2026-10-13T12:00:00.000Z",
      deadlineAt: "2026-10-14T12:00:00.000Z",
      activeFiles: 2,
      payloadComplete: false,
      verifiedObjects: 6,
      verifiedBytes: 399739836,
    };
    const result = failedSSHTransferStatus(status, "owner-stage-failed", "2026-10-13T12:40:00.000Z");
    expect(result).toMatchObject({
      state: "failed",
      finishedAt: "2026-10-13T12:40:00.000Z",
      activeFiles: 0,
      verifiedObjects: 6,
      verifiedBytes: 399739836,
      payloadComplete: false,
    });
    expect(status.state).toBe("running");
    await Bun.write(join(root, ".r2", "STATUS.json"), JSON.stringify(status));
    await markSSHTransferFailed(root);
    expect(await Bun.file(join(root, ".r2", "STATUS.json")).json()).toMatchObject({
      state: "failed",
      activeFiles: 0,
      verifiedObjects: 6,
      payloadComplete: false,
    });
    expect(() => failedSSHTransferStatus({ ...status, sourceSHA256: "b".repeat(64) })).toThrow("qualified SSH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("episode delivery refuses private and foreign acquisition assets before network staging", () => {
  const fixture = (path: string) => ({ assets: [{ path }] }) as EpisodePackageManifest;
  expect(() => assertEpisodeDeliveryScope(fixture("frames/frame-000001.png"))).not.toThrow();
  for (const path of [
    "production-manifest.private.json",
    "metadata/session.private.json",
    "catalogue/frames/other-episode.png",
  ])
    expect(() => assertEpisodeDeliveryScope(fixture(path))).toThrow("Protected or foreign");
});

test("canonical rehydrate receipts resolve their archive-relative file inside the physical episode root", () => {
  const root = resolve(tmpdir(), "bun-video-physical-episode");
  const entry = {
    file: "package/assets-0012.tar.gz",
    sha256: "b".repeat(64),
    bytes: 66777973,
    mime: "application/gzip" as const,
  };
  const expected = resolve(root, entry.file);
  expect(archiveOutputPath(root, entry, entry.file)).toBe(expected);
  expect(archiveOutputPath(root, entry, expected)).toBe(expected);
  expect(() => archiveOutputPath(root, entry, "../outside.tar.gz")).toThrow("path differs");
});

test("SSH staging is confined to the qualified source namespace and archive filenames", () => {
  expect(relayPath("a".repeat(64), "assets-0001.tar.gz")).toBe(
    `/home/ubuntu/.local/share/aphrody/media-staging/${"a".repeat(64)}/assets-0001.tar.gz`,
  );
  for (const name of ["../../credentials", "source.mp4", "assets-0001.tar.gz;rm -rf /", "assets-0001.tar.gz/other"])
    expect(() => relayPath("a".repeat(64), name)).toThrow();
  expect(() => relayPath("not-a-hash", "assets-0001.tar.gz")).toThrow();
});

test("compressed-volume overhead never exceeds the two-file 128 MiB window", () => {
  const entries = [67112087, 67082681, 64 * 1024 ** 2, 64 * 1024 ** 2 + 1].map((bytes, index) => ({
    file: `package/assets-${String(index + 1).padStart(4, "0")}.tar.gz`,
    sha256: "b".repeat(64),
    bytes,
    mime: "application/gzip" as const,
  }));
  const batches = archiveRelayBatches(entries);
  expect(batches.map(batch => batch.length)).toEqual([2, 1, 1]);
  expect(batches.flat()).toEqual(entries);
  for (const batch of batches)
    expect(batch.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(128 * 1024 ** 2);
  expect(() => archiveRelayBatches([{ ...entries[0]!, bytes: 128 * 1024 ** 2 + 1 }])).toThrow();
});

test("private owner receipts require both GET hashes, MIME and metadata", () => {
  const entry = {
    file: "package/assets-0009.tar.gz",
    sha256: "b".repeat(64),
    bytes: 67112087,
    mime: "application/gzip" as const,
  };
  const receipt = {
    schema: "shenron-owner-staged-volume/v1",
    sourceSha256: "a".repeat(64),
    kind: "media_archive",
    sha256: entry.sha256,
    key: "_objects/" + entry.sha256,
    size: entry.bytes,
    contentType: entry.mime,
    qualifiedAt: "2026-10-13T11:13:55.363Z",
    objectBytesUploaded: entry.bytes,
    pointerMutations: 0,
    registryMutations: 0,
    privateStagingOnly: true,
    attestation: {
      schema: "shenron-staged-cas-attestation/v1",
      key: "_objects/" + entry.sha256,
      sha256: entry.sha256,
      size: entry.bytes,
      actualGets: 2,
      beforeBodySha256: entry.sha256,
      afterBodySha256: entry.sha256,
      headMetadata: { sha256: entry.sha256, size: entry.bytes, contentType: entry.mime },
    },
  };
  expect(qualifiedOwnerReceipt(receipt, "a".repeat(64), entry).sha256).toBe(entry.sha256);
  const corrupt = structuredClone(receipt);
  corrupt.attestation.afterBodySha256 = "c".repeat(64);
  expect(() => qualifiedOwnerReceipt(corrupt, "a".repeat(64), entry)).toThrow();
  corrupt.attestation.afterBodySha256 = entry.sha256;
  corrupt.attestation.headMetadata.contentType = "text/plain" as "application/gzip";
  expect(() => qualifiedOwnerReceipt(corrupt, "a".repeat(64), entry)).toThrow();
});

test("receipt inventory preserves concatenated JSON boundaries and quoted braces", () => {
  const first = { sha256: "a".repeat(64), nested: { text: '}"{\\' } },
    second = { sha256: "b".repeat(64) };
  expect(parseOwnerReceiptSequence(JSON.stringify(first) + JSON.stringify(second))).toEqual([first, second]);
  expect(() => parseOwnerReceiptSequence('{"partial":')).toThrow();
  expect(() => parseOwnerReceiptSequence("unexpected")).toThrow();
});

test("local release preserves originals and rejects unqualified regenerated bytes", async () => {
  const prefix = join(tmpdir(), "bun-video-ssh-release-");
  const root = await mkdtemp(prefix);
  if (!resolve(root).startsWith(resolve(prefix)))
    throw new Error("Fixture cleanup leaves its owned temporary namespace");
  try {
    await mkdir(join(root, "package"));
    await mkdir(join(root, ".r2"));
    const bytes = new TextEncoder().encode("qualified generated archive fixture");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const entry = {
      file: "package/assets-0001.tar.gz",
      sha256,
      bytes: bytes.length,
      mime: "application/gzip" as const,
    };
    const path = join(root, entry.file);
    await Bun.write(path, bytes);
    await Bun.write(join(root, "source.mp4"), "protected-source-fixture");
    const receipt = {
      schema: "shenron-owner-staged-volume/v1",
      sourceSha256: "a".repeat(64),
      kind: "media_archive",
      sha256,
      key: "_objects/" + sha256,
      size: bytes.length,
      contentType: entry.mime,
      qualifiedAt: "2026-10-13T11:13:55.363Z",
      pointerMutations: 0,
      registryMutations: 0,
      privateStagingOnly: true,
      attestation: {
        schema: "shenron-staged-cas-attestation/v1",
        key: "_objects/" + sha256,
        sha256,
        size: bytes.length,
        actualGets: 2,
        beforeBodySha256: sha256,
        afterBodySha256: sha256,
        headMetadata: { sha256, size: bytes.length, contentType: entry.mime },
      },
    };
    expect(await releaseQualifiedRehydratedArchive(root, "a".repeat(64), entry, receipt)).toBe(false);
    expect(await Bun.file(path).exists()).toBe(true);
    const info = await lstat(path);
    await Bun.write(
      join(root, ".r2", `ssh-created-${sha256}.json`),
      JSON.stringify({
        sourceSHA: "a".repeat(64),
        file: entry.file,
        sha256,
        bytes: bytes.length,
        dev: info.dev,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        createdBy: "rehydrateEpisodeVolume",
      }),
    );
    const invalid = structuredClone(receipt);
    invalid.attestation.actualGets = 1;
    await expect(releaseQualifiedRehydratedArchive(root, "a".repeat(64), entry, invalid)).rejects.toThrow();
    expect(await Bun.file(path).exists()).toBe(true);
    expect(await releaseQualifiedRehydratedArchive(root, "a".repeat(64), entry, receipt)).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(join(root, "source.mp4")).text()).toBe("protected-source-fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
