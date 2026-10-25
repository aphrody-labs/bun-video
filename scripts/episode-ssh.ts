import { basename, dirname, join, resolve } from "node:path";
import { mkdir, rename, lstat, realpath, unlink } from "node:fs/promises";
import { safeAssetPath, rehydrateEpisodeVolume, type EpisodePackageManifest } from "../src/episode-assets";
import type { EpisodeTransferStatus } from "./episode-r2";

async function run(executable: string, args: string[], timeoutMs: number) {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...Bun.env, BUN_SSH_BACKEND: "native" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [stdout, , code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    if (timedOut || code !== 0) throw new Error(`Native SSH ${timedOut ? "deadline expired" : "operation failed"}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

async function ssh(executable: string, command: string, timeoutMs = 45000) {
  const value = JSON.parse(
    await run(
      executable,
      ["ssh", "exec", "--native", "--json", "-n", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", "dbfr", command],
      timeoutMs,
    ),
  ) as {
    code: number;
    stdout: string;
  };
  if (value.code !== 0) throw new Error("Qualified remote command failed");
  return value.stdout.trim();
}

export function relayPath(sourceSha256: string, name: string) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !/^assets-\d{4}\.tar\.gz$/.test(name))
    throw new Error("Relay paths require exact source hash and archive volume name");
  return `/home/ubuntu/.local/share/aphrody/media-staging/${sourceSha256}/${name}`;
}

export async function benchmarkSSHRelay(
  root: string,
  relativeFile: string,
  timeoutMs = 300000,
  transport: "native-sftp" | "openssh-scp" = "native-sftp",
) {
  if (!safeAssetPath(relativeFile) || !/^package\/assets-\d{4}\.tar\.gz$/.test(relativeFile))
    throw new Error("Select one already qualified package volume");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000)
    throw new Error("Invalid SSH file deadline");
  const executable = process.execPath;
  const manifest = (await Bun.file(join(root, "package/asset-index.json")).json()) as {
    episode: { source: { sha256: string } };
  };
  const file = Bun.file(join(root, relativeFile));
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of file.stream()) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (!bytes || bytes > 70 * 1024 ** 2) throw new Error("SSH staging window requires a bounded archive volume");
  const sha256 = hash.digest("hex");
  const remote = relayPath(manifest.episode.source.sha256, relativeFile.slice(8));
  const host = await ssh(executable, "hostname");
  if (host !== "vps-6732365f") throw new Error("The dbfr alias differs from the qualified execution context");
  const space = await ssh(executable, "df -B1 --output=avail /home/ubuntu | tail -n 1");
  if (!Number.isSafeInteger(Number(space)) || Number(space) < 256 * 1024 ** 2)
    throw new Error("Insufficient relay window capacity");
  const remoteRoot = dirname(remote);
  const resolved = await ssh(executable, `realpath -m '${remoteRoot}'`);
  if (resolved !== remoteRoot) throw new Error("Resolved relay path leaves its qualified namespace");
  await ssh(executable, `install -d -m 700 '${remoteRoot}'`);
  const start = performance.now();
  if (transport === "openssh-scp") {
    await run(
      executable,
      [
        "ssh",
        "cp",
        "--system",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "BatchMode=yes",
        resolve(root, relativeFile),
        `dbfr:${remote}`,
      ],
      timeoutMs,
    );
  } else
    await run(
      executable,
      [
        "ssh",
        "sftp",
        "--native",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "BatchMode=yes",
        "put",
        "dbfr",
        remote,
        resolve(root, relativeFile),
      ],
      timeoutMs,
    );
  const seconds = (performance.now() - start) / 1000;
  const actual = await ssh(executable, `sha256sum '${remote}'`);
  if (actual.split(/\s+/)[0] !== sha256) throw new Error("SSH relay changed the qualified archive bytes");
  const receipt = {
    schemaVersion: 1,
    transport: transport === "openssh-scp" ? "bun-ssh-system-scp" : "bun-ssh-native-sftp",
    host,
    sourceSHA256: manifest.episode.source.sha256,
    file: relativeFile,
    remoteFile: remote,
    bytes,
    sha256,
    seconds,
    bytesPerSecond: bytes / seconds,
    remoteSHA256Verified: true,
    r2Verified: false,
    publicationPerformed: false,
    windowMaximumFiles: 2,
    checkedAt: new Date().toISOString(),
  };
  await mkdir(join(root, ".r2"), { recursive: true });
  await Bun.write(join(root, ".r2/ssh-benchmark.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

const ownerRuntime = "/home/ubuntu/.local/share/aphrody/cloudflare-cli/runtime/bun";
const ownerDirectory = "/etc/aphrody/cloudflare/cli";
const ownerReceiptRoot = "/home/ubuntu/.aphrody/private/shenron/bun-video-875-staging-20261013/receipts";
const windowBytesMaximum = 128 * 1024 ** 2;

export interface SSHArchiveEntry {
  file: string;
  sha256: string;
  bytes: number;
  mime: "application/gzip";
}
export interface SSHArchivePlan {
  schema: "bun-video/ssh-archive-plan/v1";
  sourceSHA: string;
  manifestSHA256: string;
  entries: SSHArchiveEntry[];
  totalArchiveBytes: number;
  missingLocalArchives: number;
  windowMaximumFiles: 2;
  windowMaximumBytes: number;
}

export function assertEpisodeDeliveryScope(manifest: EpisodePackageManifest) {
  for (const asset of manifest.assets) {
    if (!safeAssetPath(asset.path) || /\.private\./i.test(asset.path) || asset.path.startsWith("catalogue/"))
      throw new Error("Protected or foreign acquisition asset cannot enter episode delivery");
  }
}

export async function prepareSSHArchivePlan(root: string) {
  root = await realpath(root);
  const bytes = await Bun.file(join(root, "package/manifest.json")).bytes();
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as EpisodePackageManifest;
  if (manifest.schemaVersion !== 1 || manifest.producer !== "bun-video" || manifest.completeness.fullyPacked !== true)
    throw new Error("Complete archive manifest required");
  assertEpisodeDeliveryScope(manifest);
  const sourceSHA = manifest.episode.source.sha256;
  relayPath(sourceSHA, "assets-0001.tar.gz");
  const entries: SSHArchiveEntry[] = manifest.bundles.map(volume => ({
    file: volume.file,
    sha256: volume.sha256,
    bytes: volume.bytes,
    mime: "application/gzip",
  }));
  archiveRelayBatches(entries);
  let missingLocalArchives = 0;
  for (const entry of entries) if (!(await Bun.file(resolve(root, entry.file)).exists())) missingLocalArchives++;
  const plan: SSHArchivePlan = {
    schema: "bun-video/ssh-archive-plan/v1",
    sourceSHA,
    manifestSHA256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    entries,
    totalArchiveBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    missingLocalArchives,
    windowMaximumFiles: 2,
    windowMaximumBytes: windowBytesMaximum,
  };
  await mkdir(join(root, ".r2"), { recursive: true });
  await writeJSON(join(root, ".r2/ssh-core-plan.json"), plan);
  return { manifest, plan };
}
export interface SSHOwnerReceipt {
  schema: "shenron-owner-staged-volume/v1";
  sourceSha256: string;
  kind: "media_archive" | "derived_core" | "extracted_frame";
  sha256: string;
  key: string;
  size: number;
  contentType: string;
  qualifiedAt: string;
  objectBytesUploaded: number;
  pointerMutations: 0;
  registryMutations: 0;
  privateStagingOnly: true;
  attestation: {
    schema: "shenron-staged-cas-attestation/v1";
    key: string;
    sha256: string;
    size: number;
    actualGets: 2;
    beforeBodySha256: string;
    afterBodySha256: string;
    headMetadata: { sha256: string; size: number; contentType: string };
  };
}

export function qualifiedOwnerReceipt(value: unknown, sourceSHA: string, entry: SSHArchiveEntry): SSHOwnerReceipt {
  const item = value as SSHOwnerReceipt;
  if (
    item?.schema !== "shenron-owner-staged-volume/v1" ||
    item.sourceSha256 !== sourceSHA ||
    item.key !== "_objects/" + entry.sha256 ||
    item.sha256 !== entry.sha256 ||
    item.size !== entry.bytes ||
    item.contentType !== entry.mime ||
    !["derived_core", "media_archive"].includes(item.kind) ||
    !Number.isFinite(Date.parse(item.qualifiedAt)) ||
    item.pointerMutations !== 0 ||
    item.registryMutations !== 0 ||
    item.privateStagingOnly !== true ||
    item.attestation?.schema !== "shenron-staged-cas-attestation/v1" ||
    item.attestation.key !== item.key ||
    item.attestation.sha256 !== entry.sha256 ||
    item.attestation.size !== entry.bytes ||
    item.attestation.actualGets !== 2 ||
    item.attestation.beforeBodySha256 !== entry.sha256 ||
    item.attestation.afterBodySha256 !== entry.sha256 ||
    item.attestation.headMetadata?.sha256 !== entry.sha256 ||
    item.attestation.headMetadata.size !== entry.bytes ||
    item.attestation.headMetadata.contentType !== entry.mime
  )
    throw new Error("Canonical owner receipt qualification differs");
  return item;
}

export function archiveRelayBatches(entries: SSHArchiveEntry[]) {
  const batches: SSHArchiveEntry[][] = [];
  for (const entry of entries) {
    if (
      !safeAssetPath(entry.file) ||
      !/^package\/assets-\d{4}\.tar\.gz$/.test(entry.file) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > windowBytesMaximum ||
      entry.mime !== "application/gzip"
    )
      throw new Error("Require bounded qualified archive volumes");
    const previous = batches.at(-1);
    if (
      previous &&
      previous.length < 2 &&
      previous.reduce((sum, file) => sum + file.bytes, 0) + entry.bytes <= windowBytesMaximum
    )
      previous.push(entry);
    else batches.push([entry]);
  }
  return batches;
}

async function hashFile(file: string) {
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(file).stream()) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function writeJSON(file: string, value: unknown) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  await Bun.write(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}

async function qualifyOwner(executable: string, ownerCheckout: string) {
  const names = ["stage-file.ts", "transfer.ts", "s3-profile.ts", "cloudflare-ops.ts"];
  const expected: string[] = [];
  for (const name of names) expected.push((await hashFile(join(ownerCheckout, "deploy/cloudflare/cli", name))).sha256);
  const command = [
    "hostname",
    `sudo -n ${ownerRuntime} ${ownerDirectory}/stage-file.ts --help`,
    `sudo -n sha256sum ${names.map(name => `${ownerDirectory}/${name}`).join(" ")}`,
  ].join(" && ");
  const output = await ssh(executable, command);
  const lines = output.split("\n");
  if (
    lines[0] !== "vps-6732365f" ||
    !lines[1]?.startsWith("stage-file --input WINDOW/<SHA>.blob|assets-NNNN.tar.gz ") ||
    !lines[1].includes("owner root only, two-volume window") ||
    names.some((name, index) => lines[index + 2] !== `${expected[index]}  ${ownerDirectory}/${name}`)
  )
    throw new Error("Remote owner command or primary source pins differ");
  return Object.fromEntries(names.map((name, index) => [name, expected[index]]));
}

async function readOwnerReceipt(executable: string, sourceSHA: string, entry: SSHArchiveEntry) {
  const path = `${ownerReceiptRoot}/${entry.sha256}.json`;
  const text = await ssh(
    executable,
    `if sudo -n test -f '${path}'; then sudo -n cat '${path}'; else printf 'missing'; fi`,
  );
  return text === "missing" ? undefined : qualifiedOwnerReceipt(JSON.parse(text), sourceSHA, entry);
}

export function parseOwnerReceiptSequence(text: string): unknown[] {
  const values: unknown[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") {
      if (depth++ === 0) start = index;
    } else if (character === "}") {
      if (--depth < 0) throw new Error("Owner receipt stream differs");
      if (depth === 0) {
        values.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    } else if (depth === 0 && character.trim()) throw new Error("Owner receipt stream differs");
  }
  if (quoted || depth || start !== -1) throw new Error("Owner receipt stream is incomplete");
  return values;
}

async function ownerReceiptInventory(executable: string) {
  const text = await ssh(
    executable,
    `sudo -n find '${ownerReceiptRoot}' -maxdepth 1 -type f -name '*.json' -exec cat '{}' +`,
  );
  const records = parseOwnerReceiptSequence(text) as SSHOwnerReceipt[];
  if (records.some(record => !/^[a-f0-9]{64}$/.test(record.sha256))) throw new Error("Owner receipt identity differs");
  return new Map(records.map(record => [record.sha256, record]));
}

async function stageArchive(
  executable: string,
  root: string,
  sourceSHA: string,
  entry: SSHArchiveEntry,
  fileTimeoutMs: number,
) {
  const remote = relayPath(sourceSHA, basename(entry.file)),
    part = remote + ".part";
  const local = resolve(root, entry.file),
    actual = await hashFile(local);
  if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
    throw new Error("Immutable local archive changed");
  await ssh(
    executable,
    `test ! -e '${part}' && test ! -e '${remote}' && test "$(stat -c %u '${dirname(remote)}')" = 1000 && test "$(stat -c %a '${dirname(remote)}')" = 700 && (umask 077; touch '${part}')`,
  );
  await run(
    executable,
    ["ssh", "sftp", "--native", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", "put", "dbfr", part, local],
    fileTimeoutMs,
  );
  const measured = await ssh(executable, `sha256sum '${part}'`);
  if (measured.split(/\s+/)[0] !== entry.sha256) throw new Error("SSH archive payload differs");
  await ssh(
    executable,
    `test ! -L '${part}' && test "$(stat -c %u '${part}')" = 1000 && test "$(stat -c %s '${part}')" = ${entry.bytes} && test ! -e '${remote}' && chmod 600 -- '${part}' && mv -T -- '${part}' '${remote}'`,
  );
  const command = `timeout --kill-after=5 300 sudo -n ${ownerRuntime} ${ownerDirectory}/stage-file.ts --input '${remote}' --sha256 ${entry.sha256} --size ${entry.bytes} --mime ${entry.mime} --source-sha256 ${sourceSHA} --kind media_archive --max-bytes ${windowBytesMaximum} --timeout-ms 300000 --apply`;
  const result = JSON.parse(await ssh(executable, command, 330000)) as {
    qualified: boolean;
    key: string;
    sha256: string;
    size: number;
    inputDeleted: boolean;
  };
  if (
    result.qualified !== true ||
    result.key !== "_objects/" + entry.sha256 ||
    result.sha256 !== entry.sha256 ||
    result.size !== entry.bytes ||
    result.inputDeleted !== true
  )
    throw new Error("Owner did not qualify and release the private staging input");
  const receipt = await readOwnerReceipt(executable, sourceSHA, entry);
  if (!receipt) throw new Error("Canonical owner durable receipt missing");
  return receipt;
}

export function archiveOutputPath(root: string, entry: SSHArchiveEntry, file: string) {
  const absolute = resolve(root, file);
  if (absolute !== resolve(root, entry.file)) throw new Error("Rehydrated archive path differs");
  return absolute;
}

async function rememberCreatedArchive(root: string, sourceSHA: string, entry: SSHArchiveEntry, file: string) {
  const absolute = archiveOutputPath(root, entry, file);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Rehydrated archive is not a regular owned file");
  await writeJSON(join(root, ".r2", `ssh-created-${entry.sha256}.json`), {
    sourceSHA,
    file: entry.file,
    sha256: entry.sha256,
    bytes: entry.bytes,
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    createdBy: "rehydrateEpisodeVolume",
  });
}

/** Delete only a rehydrated local archive with an exact canonical off-host attestation. */
export async function releaseQualifiedRehydratedArchive(
  root: string,
  sourceSHA: string,
  entry: SSHArchiveEntry,
  value: unknown,
) {
  qualifiedOwnerReceipt(value, sourceSHA, entry);
  archiveRelayBatches([entry]);
  const ledger = Bun.file(join(root, ".r2", `ssh-created-${entry.sha256}.json`));
  if (!(await ledger.exists())) return false;
  const record = (await ledger.json()) as {
    sourceSHA: string;
    file: string;
    sha256: string;
    bytes: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    createdBy: string;
  };
  if (
    record.sourceSHA !== sourceSHA ||
    record.file !== entry.file ||
    record.sha256 !== entry.sha256 ||
    record.bytes !== entry.bytes ||
    record.createdBy !== "rehydrateEpisodeVolume"
  )
    throw new Error("Rehydrated ownership record differs");
  const file = resolve(root, entry.file);
  if (!(await Bun.file(file).exists())) return false;
  const directory = await realpath(resolve(root, "package")),
    absolute = await realpath(file);
  if (dirname(absolute) !== directory || basename(absolute) !== basename(entry.file))
    throw new Error("Resolved archive deletion path leaves the intended package directory");
  const before = await lstat(absolute);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.dev !== record.dev ||
    before.ino !== record.ino ||
    before.mtimeMs !== record.mtimeMs ||
    before.size !== entry.bytes
  )
    throw new Error("Rehydrated archive ownership changed");
  const measured = await hashFile(absolute),
    after = await lstat(absolute);
  if (
    measured.sha256 !== entry.sha256 ||
    measured.bytes !== entry.bytes ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size
  )
    throw new Error("Qualified local archive changed before release");
  await unlink(absolute);
  return true;
}

/** A terminated partial sender must never advertise a live transfer. */
export function failedSSHTransferStatus<T extends EpisodeTransferStatus>(
  status: T,
  disposition = "owner-stage-failed",
  finishedAt = new Date().toISOString(),
) {
  if (
    status.schema !== "bun-video/r2-transfer-status/v1" ||
    !/^[a-f0-9]{64}$/.test(status.sourceSHA) ||
    status.sourceSHA256 !== status.sourceSHA ||
    status.transport !== "ssh" ||
    !Number.isFinite(Date.parse(finishedAt))
  )
    throw new Error("Require a qualified SSH transfer status");
  return { ...status, state: "failed" as const, finishedAt, updatedAt: finishedAt, activeFiles: 0, disposition };
}

export async function markSSHTransferFailed(root: string, disposition = "owner-stage-failed") {
  const file = join(await realpath(root), ".r2", "STATUS.json");
  if (!(await Bun.file(file).exists())) return;
  const status = (await Bun.file(file).json()) as EpisodeTransferStatus;
  if (status.state === "completed" || status.transport !== "ssh") return;
  await writeJSON(file, failedSSHTransferStatus(status, disposition));
}

/** Native SSH sender; remote root helper exclusively owns R2 attestation and temp deletion. */
export async function stageSSHArchives(
  root: string,
  ownerCheckout: string,
  options: { fileTimeoutMs?: number; jobTimeoutMs?: number; limit?: number } = {},
) {
  try {
    const result = await runSSHArchives(root, ownerCheckout, options);
    await markSSHTransferFailed(root, result.coreArchiveComplete ? "core-only-job-exited" : "partial-stage-job-exited");
    return result;
  } catch (error) {
    await markSSHTransferFailed(root);
    throw error;
  }
}

async function runSSHArchives(
  root: string,
  ownerCheckout: string,
  options: { fileTimeoutMs?: number; jobTimeoutMs?: number; limit?: number } = {},
) {
  root = await realpath(root);
  const fileTimeoutMs = options.fileTimeoutMs ?? 600000,
    jobTimeoutMs = options.jobTimeoutMs ?? 5400000;
  if (
    !Number.isSafeInteger(fileTimeoutMs) ||
    fileTimeoutMs < 1000 ||
    fileTimeoutMs > 600000 ||
    !Number.isSafeInteger(jobTimeoutMs) ||
    jobTimeoutMs < 1000 ||
    jobTimeoutMs > 86400000 ||
    (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
  )
    throw new Error("Require bounded SSH deadlines and selection");
  const executable = process.execPath;
  const { manifest, plan } = await prepareSSHArchivePlan(root);
  const sourceSHA = plan.sourceSHA,
    entries = plan.entries;
  const codePins = await qualifyOwner(executable, ownerCheckout);
  const remoteReceipts = await ownerReceiptInventory(executable);
  const work = join(root, ".r2"),
    receiptFile = join(work, "ssh-core-receipt.json"),
    statusFile = join(work, "STATUS.json");
  await mkdir(work, { recursive: true });
  const startedAt = Date.now(),
    deadline = startedAt + jobTimeoutMs,
    receipts: SSHOwnerReceipt[] = [];
  const unavailableLocalArchives: SSHArchiveEntry[] = [];
  let activeFiles = 0,
    stagedThisRun = 0,
    relayBytesThisRun = 0;
  let rehydrateQueue = Promise.resolve();
  let rehydrateFailed = false;
  let writeQueue = Promise.resolve();
  const persist = (disposition?: string) => {
    const snapshot = {
      schema: "bun-video/ssh-core-transfer/v1",
      sourceSHA,
      expectedArchives: entries.length,
      qualifiedArchives: receipts.length,
      qualifiedBytes: receipts.reduce((sum, receipt) => sum + receipt.size, 0),
      coreArchiveComplete: receipts.length === entries.length,
      payloadComplete: false,
      publicationPerformed: false,
      codePins,
      unavailableLocalArchives: [...unavailableLocalArchives],
      stagedThisRun,
      relayBytesThisRun,
      observedBytesPerSecond: relayBytesThisRun ? relayBytesThisRun / ((Date.now() - startedAt) / 1000) : null,
      estimatedRemainingSeconds: relayBytesThisRun
        ? (entries.reduce((sum, entry) => sum + entry.bytes, 0) -
            receipts.reduce((sum, receipt) => sum + receipt.size, 0)) /
          (relayBytesThisRun / ((Date.now() - startedAt) / 1000))
        : null,
      receipts: [...receipts],
      updatedAt: new Date().toISOString(),
    };
    const status = {
      schema: "bun-video/r2-transfer-status/v1",
      sourceSHA,
      sourceSHA256: sourceSHA,
      state: "running",
      transport: "ssh",
      finishedAt: null,
      payloadComplete: false,
      activeFiles,
      deadlineAt: new Date(deadline).toISOString(),
      disposition,
      updatedAt: snapshot.updatedAt,
      verifiedObjects: snapshot.qualifiedArchives,
      verifiedBytes: snapshot.qualifiedBytes,
    };
    writeQueue = writeQueue.then(async () => {
      await writeJSON(receiptFile, snapshot);
      await writeJSON(statusFile, status);
    });
    return writeQueue;
  };
  await persist("ssh-archive-staging");
  try {
    const pending: SSHArchiveEntry[] = [];
    for (const entry of entries) {
      const localReceipt = Bun.file(join(work, `ssh-owner-${entry.sha256}.json`));
      const existing = (await localReceipt.exists())
        ? qualifiedOwnerReceipt(await localReceipt.json(), sourceSHA, entry)
        : remoteReceipts.has(entry.sha256)
          ? qualifiedOwnerReceipt(remoteReceipts.get(entry.sha256), sourceSHA, entry)
          : undefined;
      if (existing) {
        receipts.push(existing);
        await writeJSON(join(work, `ssh-owner-${entry.sha256}.json`), existing);
        await releaseQualifiedRehydratedArchive(root, sourceSHA, entry, existing);
      } else {
        pending.push(entry);
        if (!(await Bun.file(resolve(root, entry.file)).exists())) unavailableLocalArchives.push(entry);
      }
      if (Date.now() >= deadline) throw new Error("SSH job deadline expired during resume qualification");
    }
    await persist("ssh-archive-staging");
    const selected = options.limit === undefined ? pending : pending.slice(0, options.limit);
    for (const batch of archiveRelayBatches(selected)) {
      if ((await Bun.file(join(work, "ssh-stop-requested")).exists()) || Date.now() >= deadline) break;
      if (Date.now() + fileTimeoutMs + 330000 > deadline) break;
      const results = await Promise.allSettled(
        batch.map(async entry => {
          activeFiles++;
          try {
            await persist("ssh-archive-staging");
            const volume = manifest.bundles.find(bundle => bundle.file === entry.file)!;
            const rebuild = rehydrateQueue.then(async () => {
              if (rehydrateFailed) throw new Error("Previous archive regeneration failed");
              const result = await rehydrateEpisodeVolume(root, manifest, volume, {
                maximumBytes: windowBytesMaximum,
                signal: AbortSignal.timeout(Math.max(1, Math.min(fileTimeoutMs, deadline - Date.now()))),
              });
              if (result.created) await rememberCreatedArchive(root, sourceSHA, entry, result.file);
              return result;
            });
            rehydrateQueue = rebuild.then(
              () => undefined,
              () => {
                rehydrateFailed = true;
              },
            );
            const reconstructed = await rebuild;
            if (!reconstructed.verified || reconstructed.sha256 !== entry.sha256 || reconstructed.bytes !== entry.bytes)
              throw new Error("Rehydrated archive differs from original immutable manifest");
            const receipt = await stageArchive(executable, root, sourceSHA, entry, fileTimeoutMs);
            await writeJSON(join(work, `ssh-owner-${entry.sha256}.json`), receipt);
            const localArchiveReleased = await releaseQualifiedRehydratedArchive(root, sourceSHA, entry, receipt);
            receipts.push(receipt);
            stagedThisRun++;
            relayBytesThisRun += entry.bytes;
            console.log(
              JSON.stringify({
                stage: "ssh-owner-qualified",
                file: entry.file,
                key: receipt.key,
                bytes: receipt.size,
                qualifiedArchives: receipts.length,
                expectedArchives: entries.length,
                doubleGetSHA256: true,
                metadataQualified: true,
                publicationPerformed: false,
                localArchiveReleased,
              }),
            );
          } finally {
            activeFiles--;
            await persist("ssh-archive-staging");
          }
        }),
      );
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    await persist(receipts.length === entries.length ? "core-archives-complete" : "partial-stage");
    return {
      qualifiedArchives: receipts.length,
      expectedArchives: entries.length,
      stagedThisRun,
      unavailableLocalArchives: unavailableLocalArchives.length,
      coreArchiveComplete: receipts.length === entries.length,
      payloadComplete: false,
      publicationPerformed: false,
    };
  } catch (error) {
    await persist("owner-stage-failed");
    throw error;
  }
}

if (import.meta.main) {
  const [root, file, timeout, option, ...rest] = Bun.argv.slice(2);
  if (root === "stage") {
    if (!file || !timeout)
      throw new Error(
        "bun scripts/episode-ssh.ts stage EPISODE_DIR SHENRON_CHECKOUT [--dry-run] [--limit N] [--job-timeout-ms N]",
      );
    const options: { limit?: number; jobTimeoutMs?: number; fileTimeoutMs?: number } = {};
    const args = option === undefined ? [] : [option, ...rest];
    let dryRun = false;
    for (let index = 0; index < args.length; index++) {
      const key = args[index]!;
      if (key === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (!["--limit", "--job-timeout-ms", "--file-timeout-ms"].includes(key))
        throw new Error("Unknown SSH staging option");
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid SSH staging option");
      if (key === "--limit") options.limit = value;
      else if (key === "--job-timeout-ms") options.jobTimeoutMs = value;
      else options.fileTimeoutMs = value;
    }
    if (dryRun) {
      const { plan } = await prepareSSHArchivePlan(resolve(file));
      console.log(
        JSON.stringify({
          dryRun: true,
          schema: plan.schema,
          sourceSHA: plan.sourceSHA,
          manifestSHA256: plan.manifestSHA256,
          archives: plan.entries.length,
          totalArchiveBytes: plan.totalArchiveBytes,
          missingLocalArchives: plan.missingLocalArchives,
          windowMaximumFiles: plan.windowMaximumFiles,
          windowMaximumBytes: plan.windowMaximumBytes,
        }),
      );
    } else console.log(JSON.stringify(await stageSSHArchives(resolve(file), resolve(timeout), options)));
  } else if (!root || !file)
    console.log("bun scripts/episode-ssh.ts EPISODE_DIR package/assets-NNNN.tar.gz [timeout-ms]");
  else
    console.log(
      JSON.stringify(
        await benchmarkSSHRelay(
          resolve(root),
          file,
          timeout ? Number(timeout) : undefined,
          option === "--scp" ? "openssh-scp" : "native-sftp",
        ),
      ),
    );
}
