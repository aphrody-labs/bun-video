#!/usr/bin/env bun
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { EpisodeAsset, EpisodePackageManifest } from "../src/episode-assets";

const volumeLimit = 64 * 1024 * 1024;
const deadline = Date.now() + 60 * 60 * 1000;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const coreKinds = new Set(["source", "video", "frame"]);

function within(root: string, path: string) {
  const child = relative(root, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${Bun.env.OS === "Windows_NT" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}

async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.recovery-tmp`;
  await Bun.write(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, path);
}

function checkDeadline() {
  if (Date.now() > deadline) throw new Error("Recovery exceeded its 60-minute deadline; checkpoints are preserved");
}

export async function recoverEpisodePackage(rootArgument: string) {
  const root = await realpath(resolve(rootArgument));
  const packageRoot = await realpath(join(root, "package"));
  if (!within(root, packageRoot)) throw new Error("Package directory must remain inside the episode directory");
  const indexPath = join(packageRoot, "asset-index.json");
  const input = (await Bun.file(indexPath).json()) as EpisodePackageManifest;
  if (input.schemaVersion !== 1 || input.producer !== "bun-video" || !Array.isArray(input.assets))
    throw new Error("Expected a Bun Video episode asset index");
  input.assets = input.assets.filter(asset => coreKinds.has(asset.kind));
  input.bundles = [];
  const byHash = new Map<string, EpisodeAsset[]>();
  for (const asset of input.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0)
      throw new Error(`Invalid asset identity: ${asset.path}`);
    delete asset.packed;
    delete asset.parts;
    const duplicates = byHash.get(asset.sha256) ?? [];
    if (duplicates.some(other => other.bytes !== asset.bytes))
      throw new Error(`Conflicting asset sizes: ${asset.sha256}`);
    duplicates.push(asset);
    byHash.set(asset.sha256, duplicates);
  }
  const volumes = (await readdir(packageRoot))
    .filter(name => /^assets-\d{4,}\.tar\.gz$/.test(name))
    .sort((a, b) => Number(a.slice(7, -7)) - Number(b.slice(7, -7)));
  for (const [position, name] of volumes.entries())
    if (Number(name.slice(7, -7)) !== position + 1)
      throw new Error(`Missing or duplicate archive number before ${name}`);
  const partHashes = new Map<string, { hasher: InstanceType<typeof Bun.CryptoHasher>; next: number }>();
  const completedParts = new Set<string>();
  let removedPartialVolume: string | undefined;
  let verifiedEntries = 0;
  let verifiedUncompressedBytes = 0;

  const packed = (asset: EpisodeAsset) => !!asset.packed || completedParts.has(asset.sha256);
  const checkpoint = async (finished: boolean) => {
    input.completeness = {
      ...input.completeness,
      indexedFrames: input.assets.filter(asset => asset.kind === "frame").length,
      indexedAssets: input.assets.length,
      packedAssets: input.assets.filter(packed).length,
      fullyPacked: input.assets.every(packed),
    };
    const progress = {
      ...input,
      recovery: {
        status: finished ? "complete" : "in-progress",
        verifiedVolumes: input.bundles.length,
        discoveredVolumes: volumes.length,
        verifiedEntries,
        verifiedUncompressedBytes,
        removedPartialVolume,
        missingFrames: input.assets.filter(asset => asset.kind === "frame" && !packed(asset)).length,
        updatedAt: new Date().toISOString(),
        owner: "Bun.Archive",
        digest: "SHA-256",
      },
    };
    await atomicJSON(join(packageRoot, "recovery-index.json"), progress);
    console.log(
      JSON.stringify({ stage: "recovery", ...progress.recovery, packedAssets: input.completeness.packedAssets }),
    );
  };

  await checkpoint(false);
  for (const [position, name] of volumes.entries()) {
    checkDeadline();
    const path = join(packageRoot, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error(`Archive must be a regular file within the package directory: ${name}`);
    // gzip headers and stored-deflate overhead may exceed the uncompressed ceiling slightly.
    if (info.size > volumeLimit + 1024 * 1024) throw new Error(`Archive exceeds the bounded volume size: ${name}`);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const digest = sha256(bytes);
    let files: Map<string, File>;
    try {
      files = await new Bun.Archive(bytes).files();
      if (files.size === 0) throw new Error("Archive contains no entries");
    } catch (error) {
      if (position !== volumes.length - 1) throw new Error(`Invalid non-final archive ${name}`, { cause: error });
      const resolved = await realpath(path);
      if (resolved !== path || !within(packageRoot, resolved) || !/^assets-\d{4,}\.tar\.gz$/.test(name))
        throw new Error("Refusing deletion outside the resolved final archive");
      await rm(resolved);
      removedPartialVolume = name;
      console.log(JSON.stringify({ stage: "removed-partial-final-volume", file: name, reason: String(error) }));
      break;
    }
    let uncompressedBytes = 0;
    const staged: (() => void)[] = [];
    for (const [entryPath, file] of files) {
      checkDeadline();
      uncompressedBytes += file.size;
      if (file.size > volumeLimit || uncompressedBytes > volumeLimit)
        throw new Error(`Uncompressed archive exceeds 64 MiB: ${name}`);
      const blob = /^blobs\/([a-f0-9]{64})\.([a-zA-Z0-9_-]+)$/.exec(entryPath);
      const part = /^parts\/([a-f0-9]{64})\/(\d{12,})$/.exec(entryPath);
      if (!blob && !part) throw new Error(`Unexpected archive entry: ${name}:${entryPath}`);
      const hash = (blob ?? part)![1]!;
      const assets = byHash.get(hash);
      if (!assets) throw new Error(`Archive entry does not identify a core asset: ${name}:${entryPath}`);
      const entryBytes = new Uint8Array(await file.arrayBuffer());
      const entryHash = sha256(entryBytes);
      const volume = `package/${name}`;
      if (blob) {
        if (entryHash !== hash || assets.some(asset => asset.bytes !== entryBytes.length))
          throw new Error(`Blob SHA-256 or size mismatch: ${name}:${entryPath}`);
        if (!assets.some(asset => String(asset.format) === blob[2]))
          throw new Error(`Blob format does not match its indexed asset: ${name}:${entryPath}`);
        if (assets.some(asset => asset.parts)) throw new Error(`Asset has both blob and parts: ${hash}`);
        staged.push(() => {
          for (const asset of assets) asset.packed ??= { volume, path: entryPath };
        });
      } else {
        const offset = Number(part![2]);
        const total = assets[0]!.bytes;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + entryBytes.length > total ||
          entryBytes.length === 0
        )
          throw new Error(`Invalid asset part bounds: ${name}:${entryPath}`);
        if (assets.some(asset => asset.packed)) throw new Error(`Asset has both parts and blob: ${hash}`);
        const state = partHashes.get(hash) ?? { hasher: new Bun.CryptoHasher("sha256"), next: 0 };
        if (offset !== state.next)
          throw new Error(`Asset parts have a gap, overlap or wrong order: ${name}:${entryPath}`);
        state.hasher.update(entryBytes);
        state.next += entryBytes.length;
        partHashes.set(hash, state);
        if (state.next === total) {
          if (state.hasher.digest("hex") !== hash) throw new Error(`Reconstructed asset SHA-256 mismatch: ${hash}`);
          completedParts.add(hash);
        }
        staged.push(() => {
          for (const asset of assets)
            (asset.parts ??= []).push({ volume, path: entryPath, offset, bytes: entryBytes.length, sha256: entryHash });
        });
      }
    }
    for (const commit of staged) commit();
    input.bundles.push({
      file: `package/${name}`,
      bytes: bytes.length,
      sha256: digest,
      entries: files.size,
      uncompressedBytes,
      compression: "gzip",
      owner: "Bun.Archive",
    });
    verifiedEntries += files.size;
    verifiedUncompressedBytes += uncompressedBytes;
    if ((position + 1) % 20 === 0) await checkpoint(false);
  }
  for (const asset of input.assets) {
    if (asset.parts) {
      asset.parts.sort((a, b) => a.offset - b.offset);
      if (!completedParts.has(asset.sha256))
        throw new Error(`Incomplete multipart source ${asset.path}; index preserved and recovery checkpoint retained`);
    }
  }
  await checkpoint(true);
  await atomicJSON(indexPath, input);
  console.log(
    JSON.stringify({
      stage: "recovered-index",
      file: indexPath,
      assets: input.assets.length,
      volumes: input.bundles.length,
      packedAssets: input.completeness.packedAssets,
      fullyPacked: input.completeness.fullyPacked,
    }),
  );
  return input;
}

if (import.meta.main) {
  const root = Bun.argv[2];
  if (!root || root === "--help") console.log("bun scripts/episode-package-recover.ts <episode-directory>");
  else await recoverEpisodePackage(root);
}
