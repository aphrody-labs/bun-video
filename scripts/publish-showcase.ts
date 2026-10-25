import { isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { createR2Client, loadCloudflareEnvironment } from "../../bun-cloudflare/src/api";

const directory = Bun.env.BUN_VIDEO_SHOWCASE_OUTPUT,
  privateDirectory = Bun.env.BUN_VIDEO_SHOWCASE_PRIVATE;
if (!directory || !privateDirectory || !isAbsolute(directory) || !isAbsolute(privateDirectory))
  throw new Error("Require absolute public and private showcase directories");
const source = await realpath(directory);
const manifest = await Bun.file(join(source, "showcase.json")).json();
if (
  manifest.schema !== "bun-video/showcase/v1" ||
  manifest.evidence.some((row: { status: string }) => row.status !== "passed")
)
  throw new Error("All selected showcase operations must pass before publication");
const inventory = await Bun.file(join(privateDirectory, "upload-plan.json")).json();
if (
  inventory.schema !== "bun-video/showcase-upload/v1" ||
  inventory.bucket !== "aphrody-video" ||
  inventory.origin !== "https://video.aphrody.com"
)
  throw new Error("Unexpected showcase destination");
const prefix = Bun.env.BUN_VIDEO_SHOWCASE_PREFIX;
if (!prefix || !/^showcase\/[a-zA-Z0-9-]+$/.test(prefix))
  throw new Error("Require an explicit versioned BUN_VIDEO_SHOWCASE_PREFIX");
const entries = [];
for (const name of inventory.files as string[]) {
  if (!/^[a-zA-Z0-9/_.,-]+$/.test(name) || name.split("/").some(part => part.startsWith(".")))
    throw new Error("Invalid artifact path");
  const file = await realpath(join(source, name));
  if (relative(source, file).startsWith("..") || resolve(file) === source)
    throw new Error("Artifact escapes public root");
  const bytes = await Bun.file(file).bytes();
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Showcase object exceeds the per-object budget");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const mime = name.startsWith("sources/") ? "text/plain; charset=utf-8" : Bun.file(file).type;
  entries.push({ file: name, key: `${prefix}/${name}`, bytes: bytes.length, sha256, mime });
}
const planFile = join(privateDirectory, "publication-plan.json");
const plan = {
  schema: "bun-video/showcase-publication/v1",
  bucket: "aphrody-video",
  origin: inventory.origin,
  prefix,
  sourceRevision: manifest.sourceRevision,
  entries,
};
if (!Bun.argv.includes("--apply")) {
  await Bun.write(planFile, JSON.stringify(plan, null, 2));
  console.log(
    JSON.stringify({
      state: "planned",
      prefix,
      objects: entries.length,
      bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    }),
  );
} else {
  const approved = await Bun.file(planFile).json();
  if (JSON.stringify(approved) !== JSON.stringify(plan)) throw new Error("Artifacts or destination changed after plan");
  const client = createR2Client({ bucket: "aphrody-video", env: await loadCloudflareEnvironment() });
  const receipts = [];
  for (const entry of entries) {
    const object = client.file(entry.key);
    if (!(await object.exists()))
      await client.write(entry.key, Bun.file(join(source, entry.file)), {
        type: entry.mime,
        retry: 0,
        queueSize: 1,
        partSize: 8 * 1024 * 1024,
      });
    const digest = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of object.stream()) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== entry.bytes || digest.digest("hex") !== entry.sha256)
      throw new Error(`Remote object verification failed: ${entry.file}`);
    receipts.push({ key: entry.key, bytes, sha256: entry.sha256, verified: true });
    await Bun.write(
      join(privateDirectory, "publication-receipt.json"),
      JSON.stringify({ complete: receipts.length === entries.length, prefix, objects: receipts }, null, 2),
    );
    if (receipts.length === 1 || receipts.length % 20 === 0 || receipts.length === entries.length)
      console.log(JSON.stringify({ verified: receipts.length, total: entries.length }));
  }
}
