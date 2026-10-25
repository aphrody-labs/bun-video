import { mkdir, rename, readdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import {
  createR2Client,
  createClient,
  credentialsFromEnv,
  loadCloudflareEnvironment,
} from "../../bun-cloudflare/src/api";
import { safeAssetPath, type EpisodePackageManifest } from "../src/episode-assets";
import { selectShenronEpisodeFrames } from "../src/shenron-episode";

export interface EpisodeUploadEntry {
  file: string;
  key: string;
  bytes: number;
  sha256: string;
  mime: string;
  routes: string[];
}
export interface EpisodeUploadPlan {
  schemaVersion: 1;
  bucket: string;
  origin: string;
  prefix: string;
  entries: EpisodeUploadEntry[];
  transport?: "s3" | "rest";
  authProfile?: string;
}
export interface EpisodeTransferStatus {
  schema: "bun-video/r2-transfer-status/v1";
  state: "running" | "completed" | "failed";
  finishedAt: string | null;
  sourceSHA: string;
  sourceSHA256: string;
  updatedAt: string;
  transport: "s3" | "rest" | "ssh";
  deadlineAt: string;
  activeFiles: number;
  payloadComplete: boolean;
  disposition?: string;
}
type ObjectReceipt = {
  key: string;
  bytes: number;
  sha256: string;
  etag: string;
  verification: "head-size-and-singlepart-md5" | "stream-get-sha256";
  action: "uploaded" | "resumed";
  checkedAt: string;
  customMetadataSha256: "verified" | "pending-owner";
};

export function episodePrefix(sourceSha256: string, wikiEpisodeId = 875) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !Number.isSafeInteger(wikiEpisodeId) || wikiEpisodeId < 1)
    throw new Error("Require qualified source SHA-256 and numeric episode ID");
  return `media/episodes/${wikiEpisodeId}/${sourceSha256}/`;
}

export function r2Origin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname.endsWith(".r2.dev") ||
    url.hostname.endsWith(".r2.cloudflarestorage.com")
  )
    throw new Error("Require the qualified HTTPS custom-domain origin");
  return url.origin;
}

/** Public manifest uses an explicit allowlist; no local absolute paths or authentication fields. */
export function publicEpisodeManifest(input: EpisodePackageManifest) {
  const episode = input.episode;
  if (!safeAssetPath(episode.source.file)) throw new Error("Unsafe public source path");
  for (const volume of input.bundles) if (!safeAssetPath(volume.file)) throw new Error("Unsafe public volume path");
  for (const asset of input.assets) {
    if (asset.packed && (!safeAssetPath(asset.packed.volume) || !safeAssetPath(asset.packed.path)))
      throw new Error("Unsafe packed asset path");
    if (asset.parts?.some(part => !safeAssetPath(part.volume) || !safeAssetPath(part.path)))
      throw new Error("Unsafe asset part path");
  }
  return {
    schemaVersion: input.schemaVersion,
    producer: input.producer,
    episode: {
      id: episode.id,
      title: episode.title,
      source: {
        file: episode.source.file,
        sha256: episode.source.sha256,
        bytes: episode.source.bytes,
        provider: episode.source.provider,
        providerEpisodeId: episode.source.providerEpisodeId,
      },
      durationSeconds: episode.durationSeconds,
      fps: { numerator: episode.fps.numerator, denominator: episode.fps.denominator },
      width: episode.width,
      height: episode.height,
      frameCount: episode.frameCount,
    },
    assets: input.assets.map(asset => {
      if (!safeAssetPath(asset.path)) throw new Error("Unsafe public asset path");
      return {
        path: asset.path,
        kind: asset.kind,
        mime: asset.mime,
        bytes: asset.bytes,
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
        frameNumber: asset.frameNumber,
        timecodeSeconds: asset.timecodeSeconds,
        language: asset.language,
        format: asset.format,
        title: asset.title,
        reference: {
          provider: asset.reference.provider,
          episodeId: asset.reference.episodeId,
          role: asset.reference.role,
          continuity: asset.reference.continuity,
        },
        ...(asset.packed ? { packed: { volume: asset.packed.volume, path: asset.packed.path } } : {}),
        ...(asset.parts
          ? {
              parts: asset.parts.map(part => ({
                volume: part.volume,
                path: part.path,
                offset: part.offset,
                bytes: part.bytes,
                sha256: part.sha256,
              })),
            }
          : {}),
      };
    }),
    bundles: input.bundles.map(volume => ({
      file: volume.file,
      bytes: volume.bytes,
      sha256: volume.sha256,
      entries: volume.entries,
      uncompressedBytes: volume.uncompressedBytes,
      compression: volume.compression,
      owner: volume.owner,
    })),
    completeness: {
      expectedFrames: input.completeness.expectedFrames,
      indexedFrames: input.completeness.indexedFrames,
      indexedAssets: input.completeness.indexedAssets,
      packedAssets: input.completeness.packedAssets,
      imageOwner: input.completeness.imageOwner,
      archiveOwner: input.completeness.archiveOwner,
      fullyPacked: input.completeness.fullyPacked,
    },
  };
}

export function directEpisodeAssets(manifest: EpisodePackageManifest, extraFrameNumbers: readonly number[]) {
  const selected = new Set(selectShenronEpisodeFrames(manifest, 240).map(frame => frame.frameNumber!));
  for (const number of extraFrameNumbers) {
    if (!Number.isSafeInteger(number) || number < 1 || number > manifest.episode.frameCount)
      throw new Error("Invalid selected reference frame number");
    selected.add(number);
  }
  if (selected.size > 600) throw new Error("Direct frame upload exceeds Shenron's 600-frame intake bound");
  return manifest.assets.filter(asset =>
    asset.kind === "frame"
      ? selected.has(asset.frameNumber!)
      : asset.kind === "source" || asset.kind === "video" || asset.bytes <= 32 * 1024 ** 2,
  );
}

async function localHashes(file: string) {
  const sha = new Bun.CryptoHasher("sha256"),
    md5 = new Bun.CryptoHasher("md5");
  let bytes = 0;
  for await (const chunk of Bun.file(file).stream()) {
    sha.update(chunk);
    md5.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: sha.digest("hex"), md5: md5.digest("hex") };
}

async function atomicJSON(file: string, value: unknown) {
  await Bun.write(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}

export async function prepareEpisodeUpload(
  root: string,
  manifest: EpisodePackageManifest,
  config: {
    bucket: string;
    origin: string;
    extraFrameNumbers: readonly number[];
    authProfile?: string;
  },
) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error("Require an explicit R2 bucket");
  if (
    !manifest.completeness.fullyPacked ||
    manifest.completeness.indexedFrames !== manifest.episode.frameCount ||
    !manifest.bundles.length
  )
    throw new Error("Require the completed and verified full episode package");
  const prefix = episodePrefix(manifest.episode.source.sha256);
  const origin = r2Origin(config.origin);
  const work = join(root, ".r2");
  await mkdir(work, { recursive: true });
  const publicFile = join(work, "public-manifest.json");
  await atomicJSON(publicFile, publicEpisodeManifest(manifest));
  const entries: EpisodeUploadEntry[] = [];
  const add = (file: string, relative: string, bytes: number, sha256: string, mime: string) => {
    if (!safeAssetPath(relative) || !Number.isSafeInteger(bytes) || bytes < 1 || !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error("Invalid qualified upload entry");
    const key = `_objects/${sha256}`;
    const previous = entries.find(entry => entry.key === key);
    if (previous) {
      if (previous.mime !== mime) throw new Error("One immutable object cannot have conflicting qualified MIME types");
      previous.routes.push(prefix + relative);
      return;
    }
    entries.push({ file, key, bytes, sha256, mime, routes: [prefix + relative] });
  };
  for (const volume of manifest.bundles)
    add(join(root, volume.file), volume.file, volume.bytes, volume.sha256, "application/gzip");
  for (const asset of directEpisodeAssets(manifest, config.extraFrameNumbers))
    add(
      join(root, asset.path),
      asset.kind === "frame" ? `${asset.sha256}.png` : asset.path,
      asset.bytes,
      asset.sha256,
      asset.mime,
    );
  const publicHash = await localHashes(publicFile);
  add(publicFile, "package/manifest.json", publicHash.bytes, publicHash.sha256, "application/json");
  const sumsFile = join(work, "public-SHA256SUMS");
  await Bun.write(
    sumsFile,
    `${publicHash.sha256}  manifest.json\n` +
      manifest.bundles.map(volume => `${volume.sha256}  ${volume.file.slice(8)}`).join("\n") +
      "\n",
  );
  const sumsHash = await localHashes(sumsFile);
  add(sumsFile, "package/SHA256SUMS", sumsHash.bytes, sumsHash.sha256, "text/plain; charset=utf-8");
  for (const relative of ["package/README.md", "package/metadata.tar.gz", "package/metadata.sha256"]) {
    const file = join(root, relative);
    if (await Bun.file(file).exists()) {
      const hash = await localHashes(file);
      add(
        file,
        relative,
        hash.bytes,
        hash.sha256,
        relative.endsWith(".tar.gz") ? "application/gzip" : "text/plain; charset=utf-8",
      );
    }
  }
  // Namespace/object names and hashes only. No local filesystem path in this public inventory.
  const inventory = entries.map(({ key, bytes, sha256, mime, routes }) => ({
    key,
    bytes,
    sha256,
    mime,
    routeHints: routes.map(route => `${origin}/${route}`),
    routesQualified: false,
  }));
  const inventoryFile = join(work, "object-inventory.json");
  await atomicJSON(inventoryFile, { schemaVersion: 1, prefix, objects: inventory });
  const inventoryHash = await localHashes(inventoryFile);
  add(inventoryFile, "package/object-inventory.json", inventoryHash.bytes, inventoryHash.sha256, "application/json");
  const plan: EpisodeUploadPlan = {
    schemaVersion: 1,
    bucket: config.bucket,
    origin,
    prefix,
    entries,
    authProfile: config.authProfile,
  };
  await atomicJSON(join(work, "upload-plan.json"), plan);
  return plan;
}

/** Stage stable completed volumes while the final package headers are still being built. */
export async function prepareCoreUpload(
  root: string,
  config: {
    bucket: string;
    origin: string;
    limit?: number;
    skip?: number;
    transport?: "s3" | "rest";
    authProfile?: string;
  },
) {
  if (config.bucket !== "shenron-cdn")
    throw new Error("Core staging requires the explicitly qualified shenron-cdn bucket");
  const manifest = (await Bun.file(join(root, "package/asset-index.json")).json()) as EpisodePackageManifest;
  const prefix = episodePrefix(manifest.episode.source.sha256);
  const origin = r2Origin(config.origin);
  // Exclude the latest filename, which may still be written or verified by the active packager.
  const names = (await readdir(join(root, "package")))
    .filter(name => /^assets-\d{4}\.tar\.gz$/.test(name))
    .sort()
    .slice(0, -1);
  if (config.limit !== undefined && (!Number.isSafeInteger(config.limit) || config.limit < 1))
    throw new Error("Invalid core volume bound");
  const entries: EpisodeUploadEntry[] = [];
  if (config.skip !== undefined && (!Number.isSafeInteger(config.skip) || config.skip < 0))
    throw new Error("Invalid core offset");
  for (const name of names.slice(config.skip ?? 0, (config.skip ?? 0) + (config.limit ?? names.length))) {
    const file = join(root, "package", name);
    const hash = await localHashes(file);
    entries.push({
      file,
      key: `_objects/${hash.sha256}`,
      bytes: hash.bytes,
      sha256: hash.sha256,
      mime: "application/gzip",
      routes: [prefix + `package/${name}`],
    });
  }
  if (!entries.length) throw new Error("No completed core volumes available");
  const plan: EpisodeUploadPlan = {
    schemaVersion: 1,
    bucket: config.bucket,
    origin,
    prefix,
    entries,
    transport: config.transport ?? "s3",
    authProfile: config.authProfile,
  };
  await mkdir(join(root, ".r2"), { recursive: true });
  await atomicJSON(join(root, ".r2/core-plan.json"), plan);
  return plan;
}

export async function prepareDirectFrames(
  root: string,
  config: { bucket: string; origin: string; transport: "s3" | "rest"; authProfile?: string },
) {
  if (config.bucket !== "shenron-cdn") throw new Error("Frame staging requires the qualified shenron-cdn bucket");
  const manifest = (await Bun.file(join(root, "package/asset-index.json")).json()) as EpisodePackageManifest;
  const handoff = (await Bun.file(join(root, "handoff/shenron-visual.json")).json()) as {
    frames: Array<{ frameNumber: number }>;
  };
  if (handoff.frames.length !== 6) throw new Error("Require the six qualified handoff reference frames");
  const prefix = episodePrefix(manifest.episode.source.sha256);
  const entries = handoff.frames.map(frame => {
    const asset = manifest.assets.find(
      candidate => candidate.kind === "frame" && candidate.frameNumber === frame.frameNumber,
    );
    if (!asset || asset.mime !== "image/png" || !safeAssetPath(asset.path))
      throw new Error("Missing original PNG handoff frame");
    return {
      file: join(root, asset.path),
      key: `_objects/${asset.sha256}`,
      bytes: asset.bytes,
      sha256: asset.sha256,
      mime: asset.mime,
      routes: [prefix + `${asset.sha256}.png`],
    };
  });
  const plan: EpisodeUploadPlan = {
    schemaVersion: 1,
    bucket: config.bucket,
    origin: r2Origin(config.origin),
    prefix,
    entries,
    transport: config.transport,
    authProfile: config.authProfile,
  };
  await mkdir(join(root, ".r2"), { recursive: true });
  await atomicJSON(join(root, ".r2/direct-plan.json"), plan);
  return plan;
}

export function normalizeETag(value: string) {
  return value.replace(/^"|"$/g, "").toLowerCase();
}

let uploadPhase = "local-hash";
let phaseFile: string | undefined;
async function markPhase(phase: string) {
  uploadPhase = phase;
  if (phaseFile) await atomicJSON(phaseFile, { phase, checkedAt: new Date().toISOString() });
}

/** An already-running master can finish its current uploads before handing off transport. */
async function stopBarrier(planFile: string, plan: EpisodeUploadPlan, index: number) {
  const directory = dirname(planFile);
  if (!(await Bun.file(join(directory, "stop-requested")).exists())) return;
  await markPhase("handoff-ssh");
  const group = basename(planFile, "-plan.json");
  const signal = AbortSignal.timeout(900000);
  await new Promise<void>((resolveBarrier, rejectBarrier) => {
    let checking = false,
      dirty = false,
      settled = false;
    const close = () => {
      settled = true;
      observer.close();
      signal.removeEventListener("abort", abort);
    };
    const check = async () => {
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        for (let prior = 0; prior < index; prior++) {
          const file = Bun.file(join(directory, `${group}-object-${String(prior).padStart(6, "0")}.json`));
          if (!(await file.exists())) return;
          const receipt = (await file.json()) as ObjectReceipt;
          if (receipt.key !== plan.entries[prior]!.key || receipt.sha256 !== plan.entries[prior]!.sha256) return;
        }
        close();
        resolveBarrier();
      } catch (error) {
        close();
        rejectBarrier(error);
      } finally {
        checking = false;
        if (dirty && !settled) {
          dirty = false;
          void check();
        }
      }
    };
    const observer = watch(directory, (_event, name) => {
      if (name?.toString().startsWith(`${group}-object-`)) void check();
    });
    const abort = () => {
      close();
      rejectBarrier(new Error("Bounded current-upload handoff timed out"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void check();
  });
  throw new Error("Transport handed off after current uploads completed");
}

async function r2Environment(plan: EpisodeUploadPlan) {
  const env = await loadCloudflareEnvironment();
  if (!plan.authProfile) return env;
  const profile = (await Bun.file(plan.authProfile).json()) as {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    bucket: string;
    prefixes: string[];
    permission: string;
    expiresAt: string;
  };
  if (
    profile.bucket !== plan.bucket ||
    profile.permission !== "object-read-write" ||
    profile.prefixes.length !== 1 ||
    profile.prefixes[0] !== "_objects/" ||
    !Number.isFinite(Date.parse(profile.expiresAt)) ||
    Date.parse(profile.expiresAt) <= Date.now()
  )
    throw new Error("Protected R2 profile is expired or differs from the qualified staging scope");
  return {
    ...env,
    R2_ENDPOINT: profile.endpoint,
    R2_ACCESS_KEY_ID: profile.accessKeyId,
    R2_SECRET_ACCESS_KEY: profile.secretAccessKey,
    R2_SESSION_TOKEN: profile.sessionToken,
  };
}

async function singleRestUpload(
  plan: EpisodeUploadPlan,
  entry: EpisodeUploadEntry,
  local: Awaited<ReturnType<typeof localHashes>>,
) {
  await markPhase("configuration");
  if (entry.bytes > 300_000_000) throw new Error("Cloudflare REST upload is bounded to 300 MB per object");
  const env = await loadCloudflareEnvironment();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("Cloudflare account is not configured");
  const client = createClient({ credentials: credentialsFromEnv(env), maxRetries: 0, timeout: 900000 });
  const params = { account_id: accountId, bucket_name: plan.bucket };
  const lookup = async () => {
    const page = await client.r2.buckets.objects.list(
      plan.bucket,
      { account_id: accountId, prefix: entry.key },
      { maxRetries: 0 },
    );
    return page.getPaginatedItems().find((object: { key?: string }) => object.key === entry.key);
  };
  await markPhase("rest-readonly-list");
  const existing = await lookup();
  if (!existing) {
    await markPhase("rest-upload");
    await client.r2.buckets.objects.upload(entry.key, Bun.file(entry.file), params, {
      headers: { "content-type": entry.mime, "x-amz-meta-sha256": entry.sha256 },
      maxRetries: 0,
    });
  }
  await markPhase("rest-verify-metadata");
  const remote = await lookup();
  if (!remote || remote.size !== entry.bytes) throw new Error("Remote immutable object size differs");
  if (remote.http_metadata?.contentType !== entry.mime) throw new Error("Remote immutable object MIME differs");
  const etag = normalizeETag(remote.etag ?? "");
  let verification: ObjectReceipt["verification"];
  if (/^[a-f0-9]{32}$/.test(etag)) {
    if (etag !== local.md5) throw new Error("Remote immutable object MD5 differs");
    verification = "head-size-and-singlepart-md5";
  } else {
    await markPhase("rest-verify-stream-get");
    const response = await client.r2.buckets.objects.get(entry.key, params, { maxRetries: 0 });
    if (!response.body) throw new Error("Remote object body is unavailable");
    const hash = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256)
      throw new Error("Remote immutable object SHA-256 differs");
    verification = "stream-get-sha256";
  }
  return {
    key: entry.key,
    bytes: entry.bytes,
    sha256: entry.sha256,
    etag,
    verification,
    action: existing ? "resumed" : "uploaded",
    checkedAt: new Date().toISOString(),
    customMetadataSha256: remote.custom_metadata?.sha256 === entry.sha256 ? "verified" : "pending-owner",
  } as ObjectReceipt;
}

async function singleUpload(planFile: string, index: number): Promise<ObjectReceipt> {
  phaseFile = join(dirname(planFile), `${basename(planFile, ".json")}-phase-${index}.json`);
  await markPhase("local-hash");
  const plan = (await Bun.file(planFile).json()) as EpisodeUploadPlan;
  const entry = plan.entries[index];
  if (!entry || entry.key !== `_objects/${entry.sha256}`) throw new Error("Invalid content-addressed upload entry");
  await stopBarrier(planFile, plan, index);
  const local = await localHashes(entry.file);
  if (local.bytes !== entry.bytes || local.sha256 !== entry.sha256)
    throw new Error("Local artifact changed after qualification");
  if (plan.transport === "rest") return singleRestUpload(plan, entry, local);
  await markPhase("configuration");
  const client = createR2Client({ bucket: plan.bucket, env: await r2Environment(plan) });
  const object = client.file(entry.key);
  await markPhase("head");
  const exists = await object.exists();
  await markPhase("upload");
  if (!exists)
    await client.write(
      entry.key,
      new Response(Bun.file(entry.file).stream(), { headers: { "content-type": entry.mime } }),
      {
        type: entry.mime,
        queueSize: 2,
        retry: 0,
        partSize: 8 * 1024 * 1024,
      },
    );
  await markPhase("verify-head");
  const stat = await object.stat();
  if (stat.size !== entry.bytes) throw new Error("Immutable R2 object has an unexpected size");
  const etag = normalizeETag(stat.etag);
  let verification: ObjectReceipt["verification"];
  if (/^[a-f0-9]{32}$/.test(etag)) {
    if (etag !== local.md5) throw new Error("Immutable R2 object differs from the local MD5");
    verification = "head-size-and-singlepart-md5";
  } else {
    await markPhase("verify-stream-get");
    const hash = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of object.stream()) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256)
      throw new Error("Immutable R2 object differs from the local SHA-256");
    verification = "stream-get-sha256";
  }
  await markPhase("verify-custom-metadata");
  const metadata = await fetch(object.presign({ method: "HEAD", expiresIn: 60 }), {
    method: "HEAD",
    signal: AbortSignal.timeout(15000),
  });
  if (
    metadata.status !== 200 ||
    Number(metadata.headers.get("content-length")) !== entry.bytes ||
    metadata.headers.get("content-type") !== entry.mime
  )
    throw new Error("Remote metadata HEAD differs from the qualified artifact");
  return {
    key: entry.key,
    bytes: entry.bytes,
    sha256: entry.sha256,
    etag,
    verification,
    action: exists ? "resumed" : "uploaded",
    checkedAt: new Date().toISOString(),
    customMetadataSha256: metadata.headers.get("x-amz-meta-sha256") === entry.sha256 ? "verified" : "pending-owner",
  };
}

export async function uploadEpisodePlan(
  root: string,
  fileTimeoutMs = 900000,
  jobTimeoutMs = 5400000,
  group = "upload",
) {
  if (![fileTimeoutMs, jobTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1000 && value <= 86400000))
    throw new Error("Require bounded upload deadlines");
  if (group !== "upload" && group !== "core" && group !== "direct") throw new Error("Invalid upload group");
  const planFile = join(root, `.r2/${group}-plan.json`);
  const plan = (await Bun.file(planFile).json()) as EpisodeUploadPlan;
  const receiptFile = join(root, `.r2/${group}-receipt.json`);
  const receipts: ObjectReceipt[] = [];
  const active = new Set<ReturnType<typeof Bun.spawn>>();
  let cursor = 0;
  const deadline = Date.now() + jobTimeoutMs;
  const stopFile = join(root, ".r2/stop-requested");
  const statusFile = join(root, ".r2/STATUS.json");
  const sourceSHA256 = plan.prefix.match(/\/([a-f0-9]{64})\/$/)?.[1];
  if (!sourceSHA256) throw new Error("Invalid qualified episode namespace");
  const status = (state: EpisodeTransferStatus["state"], disposition?: string): EpisodeTransferStatus => ({
    schema: "bun-video/r2-transfer-status/v1",
    state,
    finishedAt: state === "running" ? null : new Date().toISOString(),
    sourceSHA: sourceSHA256,
    sourceSHA256,
    updatedAt: new Date().toISOString(),
    transport: plan.transport ?? "s3",
    deadlineAt: new Date(deadline).toISOString(),
    activeFiles: active.size,
    payloadComplete: false,
    disposition,
  });
  let failed = false;
  const progressSnapshot = () => ({
    schemaVersion: 1,
    bucket: plan.bucket,
    origin: plan.origin,
    prefix: plan.prefix,
    expectedObjects: plan.entries.length,
    verifiedObjects: receipts.length,
    verifiedBytes: receipts.reduce((sum, object) => sum + object.bytes, 0),
    objects: [...receipts],
    complete: false,
    publicationPerformed: false,
    metadataQualified: false,
    checkedAt: new Date().toISOString(),
  });
  // Replace any receipt from an earlier probe before starting the new bounded plan.
  await atomicJSON(receiptFile, progressSnapshot());
  await atomicJSON(statusFile, status("running"));
  let progressWrite = Promise.resolve();
  const worker = async () => {
    while (!failed && cursor < plan.entries.length) {
      if (await Bun.file(stopFile).exists()) break;
      const index = cursor++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failed = true;
        throw new Error("Bounded R2 upload job timed out");
      }
      const child = Bun.spawn([process.execPath, import.meta.path, "single", planFile, String(index)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      active.add(child);
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        Math.min(fileTimeoutMs, remaining),
      );
      try {
        const [stdout, diagnostics, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
        if (code !== 0 || timedOut)
          throw new Error(
            `R2 object upload ${timedOut ? "timed out" : "failed"}: ${plan.entries[index]!.key}; phase=${diagnostics.match(/failed at ([a-z-]+)/)?.[1] ?? "unknown"}`,
          );
        const receipt = JSON.parse(stdout) as ObjectReceipt;
        receipts.push(receipt);
        // Each record owns its file, avoiding concurrent writes to a shared receipt.
        await atomicJSON(join(root, `.r2/${group}-object-${String(index).padStart(6, "0")}.json`), receipt);
        if (receipts.length === 1 || receipts.length % 10 === 0 || receipts.length === plan.entries.length) {
          const snapshot = progressSnapshot();
          progressWrite = progressWrite.then(() => atomicJSON(receiptFile, snapshot));
          await progressWrite;
          console.log(
            JSON.stringify({
              stage: "r2-object",
              ...receipt,
              completed: receipts.length,
              total: plan.entries.length,
              verifiedBytes: receipts.reduce((sum, item) => sum + item.bytes, 0),
            }),
          );
        }
      } catch (error) {
        failed = true;
        for (const running of active) running.kill();
        throw error;
      } finally {
        clearTimeout(timer);
        active.delete(child);
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
  };
  const results = await Promise.allSettled([worker(), worker()]);
  await progressWrite;
  const receipt = {
    schemaVersion: 1,
    bucket: plan.bucket,
    origin: plan.origin,
    prefix: plan.prefix,
    expectedObjects: plan.entries.length,
    verifiedObjects: receipts.length,
    verifiedBytes: receipts.reduce((sum, object) => sum + object.bytes, 0),
    objects: receipts.sort((a, b) => a.key.localeCompare(b.key)),
    complete: results.every(result => result.status === "fulfilled") && receipts.length === plan.entries.length,
    publicationPerformed: false,
    metadataQualified:
      receipts.length === plan.entries.length && receipts.every(object => object.customMetadataSha256 === "verified"),
    metadataPendingObjects: receipts.filter(object => object.customMetadataSha256 !== "verified").length,
    failures: results.flatMap(result => (result.status === "rejected" ? [String(result.reason.message)] : [])),
    checkedAt: new Date().toISOString(),
  };
  await atomicJSON(receiptFile, receipt);
  const handedOff = await Bun.file(stopFile).exists();
  const payloadComplete = group === "upload" && receipt.complete;
  await atomicJSON(
    statusFile,
    handedOff
      ? {
          ...status("running", "handoff-ssh"),
          transport: "ssh",
          payloadComplete: false,
        }
      : {
          ...status(
            payloadComplete ? "completed" : receipt.complete ? "running" : "failed",
            receipt.complete && !payloadComplete ? "partial-stage" : undefined,
          ),
          payloadComplete,
        },
  );
  if (handedOff) return { ...receipt, disposition: "handoff-ssh" };
  if (!receipt.complete) throw new Error("R2 upload incomplete; rerun upload to validate existing objects and resume");
  return receipt;
}

async function main() {
  const [mode, rootArgument, ...args] = Bun.argv.slice(2);
  if (!mode || mode === "--help") {
    console.log(
      "bun scripts/episode-r2.ts plan|upload|stage-core EPISODE_DIR --bucket NAME --origin https://CUSTOM_DOMAIN [--limit N] [--transport s3|rest] [--file-timeout-ms 900000] [--job-timeout-ms 5400000]",
    );
    return;
  }
  if (mode === "single") {
    try {
      console.log(JSON.stringify(await singleUpload(rootArgument!, Number(args[0]))));
    } catch (error) {
      const native = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: string };
      const code =
        typeof native.code === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(native.code) ? native.code : "unknown";
      const status =
        typeof native.status === "number"
          ? native.status
          : typeof native.statusCode === "number"
            ? native.statusCode
            : Number(native.message?.match(/(?:status|HTTP)[^\d]{0,15}([1-5]\d\d)/)?.[1]) || null;
      console.error(
        `Native R2 object operation failed at ${uploadPhase}; authentication and request data remain private`,
      );
      console.error(
        JSON.stringify({
          code,
          status,
          errorFields: typeof error === "object" && error ? Object.getOwnPropertyNames(error) : [],
        }),
      );
      process.exitCode = 1;
    }
    return;
  }
  if (mode === "head-probe") {
    const plan = (await Bun.file(rootArgument!).json()) as EpisodeUploadPlan;
    const entry = plan.entries[Number(args[0])];
    if (!entry || entry.key !== `_objects/${entry.sha256}`) throw new Error("Invalid content-addressed probe");
    const client = createR2Client({ bucket: plan.bucket, env: await r2Environment(plan) });
    const response = await fetch(client.file(entry.key).presign({ method: "HEAD", expiresIn: 60 }), {
      method: "HEAD",
      signal: AbortSignal.timeout(15000),
    });
    console.log(
      JSON.stringify({
        phase: "head-probe",
        status: response.status,
        bytes: response.headers.get("content-length"),
        etag: response.headers.get("etag"),
        metadataHashMatches: response.headers.get("x-amz-meta-sha256") === entry.sha256,
      }),
    );
    return;
  }
  if (mode === "rest-probe") {
    const plan = (await Bun.file(rootArgument!).json()) as EpisodeUploadPlan;
    const entry = plan.entries[Number(args[0])];
    if (!entry || entry.key !== `_objects/${entry.sha256}`) throw new Error("Invalid content-addressed probe");
    const env = await loadCloudflareEnvironment();
    const client = createClient({ credentials: credentialsFromEnv(env), maxRetries: 0, timeout: 15000 });
    const response = await client.r2.buckets.objects
      .list(
        plan.bucket,
        { account_id: env.CLOUDFLARE_ACCOUNT_ID!, prefix: entry.key },
        { signal: AbortSignal.timeout(15000), maxRetries: 0, timeout: 15000 },
      )
      .asResponse();
    const data = (await response.json()) as { result: unknown };
    console.log(
      JSON.stringify({
        phase: "rest-probe",
        status: response.status,
        resultType: typeof data.result,
        resultFields: data.result && typeof data.result === "object" ? Object.keys(data.result) : [],
      }),
    );
    return;
  }
  if (mode === "metadata-probe") {
    const plan = (await Bun.file(rootArgument!).json()) as EpisodeUploadPlan;
    const entry = plan.entries[Number(args[0])];
    if (!entry || entry.key !== `_objects/${entry.sha256}`) throw new Error("Invalid content-addressed probe");
    const client = createR2Client({ bucket: plan.bucket, env: await r2Environment(plan) });
    const object = client.file(entry.key);
    const local = await localHashes(entry.file);
    const initial = await object.stat();
    if (initial.size !== entry.bytes || normalizeETag(initial.etag) !== local.md5)
      throw new Error("Only an already verified singlepart object can be probed");
    const response = await fetch(object.presign({ method: "PUT", expiresIn: 60 }), {
      method: "PUT",
      headers: {
        "x-amz-copy-source": `/${plan.bucket}/${entry.key}`,
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-meta-sha256": entry.sha256,
        "content-type": entry.mime,
      },
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    const errorCode = text.match(/<Code>([A-Za-z0-9_-]{1,80})<\/Code>/)?.[1] ?? null;
    const head = await fetch(object.presign({ method: "HEAD", expiresIn: 60 }), {
      method: "HEAD",
      signal: AbortSignal.timeout(15000),
    });
    console.log(
      JSON.stringify({
        phase: "metadata-probe",
        status: response.status,
        errorCode,
        metadataHashMatches: head.headers.get("x-amz-meta-sha256") === entry.sha256,
        mimeMatches: head.headers.get("content-type") === entry.mime,
        bytesMatch: Number(head.headers.get("content-length")) === entry.bytes,
        md5Matches: normalizeETag(head.headers.get("etag") ?? "") === local.md5,
      }),
    );
    return;
  }
  const root = resolve(rootArgument ?? "");
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  if (!rootArgument) throw new Error("Require the selected local episode directory");
  if (mode === "plan") {
    const bucket = option("--bucket"),
      origin = option("--origin");
    if (!bucket || !origin) throw new Error("Require the qualified explicit bucket and domain; neither is inferred");
    const manifest = (await Bun.file(join(root, "package/manifest.json")).json()) as EpisodePackageManifest;
    const best = (await Bun.file(join(root, "dataset/best-frames.json")).json()) as Array<{
      frame: { sourceFrameNumber: number };
    }>;
    const handoff = (await Bun.file(join(root, "handoff/shenron-visual.json")).json()) as {
      frames: Array<{ frameNumber: number }>;
    };
    const plan = await prepareEpisodeUpload(root, manifest, {
      bucket,
      origin,
      authProfile: option("--profile"),
      extraFrameNumbers: [
        ...best.map(row => row.frame.sourceFrameNumber),
        ...handoff.frames.map(frame => frame.frameNumber),
      ],
    });
    console.log(
      JSON.stringify({
        stage: "r2-plan",
        bucket,
        origin: plan.origin,
        prefix: plan.prefix,
        objects: plan.entries.length,
        bytes: plan.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      }),
    );
  } else if (mode === "stage-core" || mode === "stage-direct") {
    const bucket = option("--bucket"),
      origin = option("--origin");
    if (!bucket || !origin) throw new Error("Require the qualified bucket and custom domain");
    const transport = option("--transport") ?? "s3";
    if (transport !== "s3" && transport !== "rest") throw new Error("Expected s3 or rest transport");
    const group = mode === "stage-core" ? "core" : "direct";
    const plan =
      mode === "stage-direct"
        ? await prepareDirectFrames(root, { bucket, origin, transport, authProfile: option("--profile") })
        : await prepareCoreUpload(root, {
            bucket,
            origin,
            limit: option("--limit") ? Number(option("--limit")) : undefined,
            skip: option("--skip") ? Number(option("--skip")) : undefined,
            transport,
            authProfile: option("--profile"),
          });
    console.log(
      JSON.stringify({
        stage: `r2-${group}-plan`,
        objects: plan.entries.length,
        bytes: plan.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      }),
    );
    const receipt = await uploadEpisodePlan(
      root,
      Number(option("--file-timeout-ms") ?? 900000),
      Number(option("--job-timeout-ms") ?? 5400000),
      group,
    );
    console.log(
      JSON.stringify({
        stage: `r2-${group}-complete`,
        complete: receipt.complete,
        verifiedObjects: receipt.verifiedObjects,
        verifiedBytes: receipt.verifiedBytes,
      }),
    );
  } else if (mode === "upload") {
    console.log(
      JSON.stringify(
        await uploadEpisodePlan(
          root,
          Number(option("--file-timeout-ms") ?? 900000),
          Number(option("--job-timeout-ms") ?? 5400000),
        ),
      ),
    );
  } else throw new Error("Expected plan or upload");
}

if (import.meta.main) await main();
