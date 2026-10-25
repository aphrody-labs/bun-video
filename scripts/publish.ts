import { join, resolve } from "node:path";
import { inspectPackageArchive } from "./qualify-package";
import { verifyLibrary } from "./verify-library";

const root = resolve(import.meta.dir, "..");
const library = await verifyLibrary(root);
const directory = resolve(root, "../../build/media/video-package-qualification");
const receipt = await Bun.file(join(directory, "package-consumer-qualification.json")).json();
const archive = join(directory, `aphrody-bun-video-${library.version}.tgz`);
const inspected = await inspectPackageArchive(await Bun.file(archive).bytes());
if (
  receipt.schemaVersion !== 1 ||
  receipt.passed !== true ||
  receipt.types?.source !== "registry" ||
  receipt.types?.passed !== true ||
  !/^[a-f0-9]{64}$/.test(receipt.types?.manifestSha256 ?? "") ||
  receipt.archive !== archive.split(/[\\/]/).pop() ||
  receipt.version !== library.version ||
  receipt.sha256 !== inspected.sha256 ||
  receipt.revision !== Bun.revision ||
  !Array.isArray(receipt.exports) ||
  receipt.exports.length !== inspected.exports.length ||
  receipt.exports.some((entry: { ok: boolean }) => !entry.ok) ||
  !Object.keys(receipt.checks ?? {}).length ||
  Object.values(receipt.checks).some(value => value !== true)
)
  throw new Error("npm next requires this exact archive to pass the current outside-consumer gate");
const child = Bun.spawn([process.execPath, "publish", archive, "--access", "public", "--tag", "next"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  timeout: 120_000,
});
const code = await child.exited;
if (code !== 0 || child.signalCode) throw new Error("npm next publication failed or exceeded its deadline");
