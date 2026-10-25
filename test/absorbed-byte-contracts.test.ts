import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readPlainFile } from "../hyperframes/cli/src/utils/projectRecords";
import { localizeExternalAssets } from "../hyperframes/cli/src/utils/publishProject";
import { snapshotBeforeWrite } from "../hyperframes/studio-server/src/helpers/backupJournal";
import { resolveFrom } from "../remotion/cli/src/resolve-from";

const work = mkdtempSync(join(tmpdir(), "bun-video-byte-contracts-"));
const project = join(work, "project");
const external = join(work, "outside");
beforeAll(() => {
  mkdirSync(project);
  mkdirSync(external);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

test("record tails decode exactly the selected UTF-8 bytes", async () => {
  const file = join(project, "record.log");
  await Bun.write(file, "début 悟空 fin");
  expect(readPlainFile(file, Buffer.byteLength("悟空 fin", "utf8"))).toBe("悟空 fin");
});

test("the ESM resolver preserves builtin names and unresolved-module errors", () => {
  expect(resolveFrom(project, "node:path")).toBe("node:path");
  expect(() => resolveFrom(project, "bun-video-absent-fixture-module")).toThrow("Cannot find module");
});

test("localized CSS retains UTF-8 content and the archive Buffer contract", async () => {
  await Bun.write(join(external, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const files = new Map<string, Buffer>([
    ["scene.css", Buffer.from('/* 悟空 */ .scene { background: url("../outside/icon.svg"); }', "utf8")],
  ]);
  expect(localizeExternalAssets(project, files)).toBe(1);
  const css = files.get("scene.css")!;
  expect(Buffer.isBuffer(css)).toBe(true);
  expect(css.toString("utf8")).toContain("悟空");
  expect(css.toString("utf8")).toContain("_ext/");
});

test("Unicode journal names use base64url keys and preserve source bytes", async () => {
  const name = "悟空.css";
  const file = join(project, name);
  await Bun.write(file, "悟空 { color: inherit; }");
  const result = snapshotBeforeWrite(project, file);
  expect(result.backupPath).not.toBeNull();
  expect(basename(result.backupPath!)).toContain(Buffer.from(name, "utf8").toString("base64url"));
  expect(await Bun.file(result.backupPath!).text()).toBe("悟空 { color: inherit; }");
});
