import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { qualifyPackageConsumer } from "./qualify-package";
import { verifyLibrary } from "./verify-library";

export async function packLibrary(root = resolve(import.meta.dir, "..")) {
  const library = await verifyLibrary(root);
  const directory = resolve(root, "../../build/media/video-package-qualification");
  await mkdir(directory, { recursive: true });
  const filename = `aphrody-bun-video-${library.version}.tgz`;
  const archive = join(directory, filename);
  const member = relative(directory, archive);
  if (isAbsolute(member) || member.startsWith("..")) throw new Error("Package version escaped its artifact directory");
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "pm", "pack", "--ignore-scripts", "--destination", directory, "--quiet"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (
    code !== 0 ||
    child.signalCode ||
    stdout.length > 1024 * 1024 ||
    stderr.length > 1024 * 1024 ||
    !(await Bun.file(archive).exists())
  )
    throw new Error(
      `Library packaging failed (code=${code}, signal=${child.signalCode ?? "none"}, archive=${await Bun.file(archive).exists()}): ${stderr.slice(0, 4096)}`,
    );
  const typesManifest = await Bun.file(resolve(root, "../bun-types/package.json")).json();
  const typesArchive = join(directory, `aphrody-bun-types-${typesManifest.version}.tgz`);
  const qualified = await qualifyPackageConsumer(
    archive,
    Bun.env.BUN_VIDEO_TYPES_VERSION ? { typesVersion: Bun.env.BUN_VIDEO_TYPES_VERSION } : { typesArchive },
  );
  const failures = qualified.exports.filter((entry: { ok: boolean }) => !entry.ok);
  const checks = Object.values(qualified.checks);
  const pass = failures.length === 0 && checks.length > 0 && checks.every(value => value === true);
  const { consumer: _consumer, ...report } = qualified;
  await Bun.write(
    join(directory, "package-consumer-qualification.json"),
    JSON.stringify({ schemaVersion: 1, archive: filename, passed: pass, ...report }, null, 2) + "\n",
  );
  if (!pass) throw new Error(`Published archive failed its outside-consumer gate (${failures.length} exports)`);
  return { archive, sha256: qualified.sha256, version: qualified.version, exports: qualified.exports.length };
}

if (import.meta.main) console.log(JSON.stringify(await packLibrary()));
