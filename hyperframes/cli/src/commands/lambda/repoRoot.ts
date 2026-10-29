/**
 * Resolve the HyperFrames repo root. Used by `lambda deploy`/`destroy`
 * to find `examples/aws-lambda/template.yaml` and the handler ZIP build
 * script.
 *
 * Walks up from this file's location until it finds a directory that
 * contains `packages/aws-lambda/`. Undefined outside a checkout (the
 * published CLI), where deploy uses the adapter's prebuilt handler.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string | undefined {
  const override = process.env.HYPERFRAMES_REPO_ROOT;
  if (override) {
    if (existsSync(resolve(override, "aws-lambda", "src"))) return override;
    throw new Error(
      "[hyperframes lambda] HYPERFRAMES_REPO_ROOT is not a hyperframes checkout " +
        "(no aws-lambda/src there). Point it at the repo root, or unset it.",
    );
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(resolve(dir, "aws-lambda", "src"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
