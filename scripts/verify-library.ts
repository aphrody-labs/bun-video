import { isAbsolute, join, relative, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { libraryPlan, type LibraryManifest } from "./library-plan";

function hash(input: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export async function assertLibraryOutputDirectory(root: string, allowMissing = false) {
  const directory = resolve(root, "dist");
  const owner = await realpath(root);
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT")
      return join(owner, "dist");
    throw error;
  }
  const physical = await realpath(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || physical !== join(owner, "dist"))
    throw new Error("Library output directory redirects outside its owner");
  return physical;
}

/** A refresh can replace only files bound by the previous producer's hashes. */
export async function ownedLibraryOutputs(root: string) {
  const directory = resolve(root, "dist");
  const physicalDirectory = await assertLibraryOutputDirectory(root);
  const file = Bun.file(join(directory, "library-receipt.json"));
  if (!(await file.exists()) || file.size > 32 * 1024 * 1024)
    throw new Error("Previous library ownership receipt is absent or oversized");
  const receipt = await file.json();
  const manifest = await Bun.file(join(root, "package.json")).json();
  if (
    receipt.schemaVersion !== 1 ||
    receipt.package !== manifest.name ||
    !Array.isArray(receipt.outputs) ||
    !receipt.outputs.length ||
    receipt.outputs.length > 20_000
  )
    throw new Error("Previous library ownership receipt is invalid");
  const names = new Map<string, string>();
  let bytes = 0;
  for (const output of receipt.outputs) {
    const path = resolve(directory, output.name);
    const member = relative(directory, path);
    if (
      !member ||
      isAbsolute(member) ||
      member.startsWith("..") ||
      output.name.includes("\\") ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(output.sha256)
    )
      throw new Error("Previous library output escapes its owned directory");
    if (names.has(output.name)) {
      if (names.get(output.name) !== output.sha256) throw new Error("Conflicting previous library ownership");
      continue;
    }
    const metadata = await lstat(path);
    const file = Bun.file(path);
    bytes += output.bytes;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await realpath(path)) !== resolve(physicalDirectory, output.name) ||
      file.size !== output.bytes ||
      bytes > 256 * 1024 * 1024 ||
      hash(await file.bytes()) !== output.sha256
    )
      throw new Error("Previous library output changed; refresh refused");
    names.set(output.name, output.sha256);
  }
  for await (const name of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true, followSymlinks: false })) {
    if (name !== "library-receipt.json" && !names.has(name.replaceAll("\\", "/")))
      throw new Error("Unowned file prevents library refresh");
  }
  return new Set(names.keys());
}

export async function verifyLibrary(root = resolve(import.meta.dir, "..")) {
  const physicalDirectory = await assertLibraryOutputDirectory(root);
  const manifestFile = Bun.file(join(root, "package.json"));
  const manifest = (await manifestFile.json()) as LibraryManifest;
  const plan = libraryPlan(manifest);
  if (
    JSON.stringify(manifest.exports) !== JSON.stringify(plan.exports) ||
    JSON.stringify(manifest.bin) !== JSON.stringify(plan.bins)
  )
    throw new Error("Published entrypoints diverge from their canonical source plan");
  const receiptFile = Bun.file(join(root, "dist/library-receipt.json"));
  if (!(await receiptFile.exists()) || receiptFile.size > 16 * 1024 * 1024)
    throw new Error("A fresh library build receipt is required before packaging");
  const receipt = (await receiptFile.json()) as {
    schemaVersion: number;
    package: string;
    version: string;
    manifestSha256: string;
    outputs: Array<{ name: string; bytes: number; sha256: string }>;
    inputs: Array<{ name: string; bytes: number; sha256: string }>;
  };
  if (
    receipt.schemaVersion !== 1 ||
    receipt.package !== manifest.name ||
    receipt.version !== manifest.version ||
    receipt.manifestSha256 !== hash(await manifestFile.bytes()) ||
    !Array.isArray(receipt.outputs) ||
    !receipt.outputs.length ||
    receipt.outputs.length > 20_000 ||
    !Array.isArray(receipt.inputs) ||
    receipt.inputs.length > 30_000
  )
    throw new Error("Library receipt does not bind this package manifest");
  const outputNames = new Set<string>();
  let bytes = 0;
  for (const output of receipt.outputs) {
    const path = resolve(root, "dist", output.name);
    const member = relative(resolve(root, "dist"), path);
    if (isAbsolute(member) || member.startsWith("..") || outputNames.has(output.name))
      throw new Error("Library receipt contains an unsafe or duplicate output");
    outputNames.add(output.name);
    const file = Bun.file(path);
    const metadata = await lstat(path);
    bytes += output.bytes;
    if (
      !(await file.exists()) ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await realpath(path)) !== resolve(physicalDirectory, output.name) ||
      file.size !== output.bytes ||
      bytes > 256 * 1024 * 1024 ||
      hash(await file.bytes()) !== output.sha256
    )
      throw new Error(`Library output changed after compilation: ${output.name}`);
  }
  for (const expected of [...plan.outputs, ...plan.typeOutputs]) {
    if (!outputNames.has(expected.slice("./dist/".length)))
      throw new Error(`Library receipt omits a public entry: ${expected}`);
  }
  // Checkout source changes invalidate the payload; installed consumers only use the compiled closure.
  const checkout = resolve(root, "../..");
  for (const input of receipt.inputs) {
    const path = resolve(root, input.name);
    const member = relative(checkout, path);
    if (
      isAbsolute(member) ||
      member.startsWith("..") ||
      /(^|[\\/])(?:\.env[^\\/]*|cookies|sessions|\.local)([\\/]|$)/i.test(member)
    )
      throw new Error("Library receipt references a protected or external build input");
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size !== input.bytes || hash(await file.bytes()) !== input.sha256)
      throw new Error(`Library input changed after compilation: ${input.name}`);
  }
  for await (const name of new Bun.Glob("**/*").scan({
    cwd: join(root, "dist"),
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (name !== "library-receipt.json" && !outputNames.has(name.replaceAll("\\", "/")))
      throw new Error(`Unowned or stale file in the library payload: ${name}`);
  }
  return {
    package: manifest.name,
    version: manifest.version,
    files: outputNames.size,
    bytes,
    sourceInputs: receipt.inputs.length,
  };
}

if (import.meta.main) console.log(JSON.stringify(await verifyLibrary()));
