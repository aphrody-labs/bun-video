import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSourcePaths } from "../scripts/check-format";

test("native format inputs retain JS and nested TSX without selecting unsupported HTML or vendor", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-video-format-"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "packages", "vendor"), { recursive: true });
  await writeFile(join(root, "src", "nested", "view.tsx"), "export const View=()=> <p>Video</p>;\n");
  await writeFile(join(root, "src", "runtime.js"), "export const enabled=true;\n");
  await writeFile(join(root, "src", "page.html"), "<p>Capture</p>\n");
  await writeFile(join(root, "packages", "vendor", "engine.ts"), "export const engine=1;\n");
  const paths = await formatSourcePaths(root);
  expect(paths.map(path => path.replaceAll("\\", "/"))).toEqual(["src/nested/view.tsx", "src/runtime.js"]);
  const child = Bun.spawn([process.execPath, "fmt", "--check", ...paths], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toContain("need formatting");
  expect(output.replaceAll("\r\n", "\n")).toBe("src/nested/view.tsx\nsrc/runtime.js\n");
  expect(code).toBe(1);
});
