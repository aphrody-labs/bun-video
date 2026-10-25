import { expect, test } from "bun:test";
import { runQualificationProcess } from "../scripts/qualification-process";

test("qualification process retains binary output and failure status in its selected environment", async () => {
  const name = "BUN_VIDEO_UNSELECTED_TEST_SECRET";
  const previous = process.env[name];
  process.env[name] = "synthetic-parent-only";
  try {
    const output = await runQualificationProcess(
      [
        "-e",
        `if(process.env.${name}!==undefined)throw new Error('parent environment leaked');
if(process.env.SELECTED!=='fixture')throw new Error('selected environment missing');
process.stdout.write(Buffer.from([0,255,42]));process.stderr.write('fixture-error');process.exitCode=7;`,
      ],
      {
        cwd: import.meta.dir,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          BUN_DEBUG_QUIET_LOGS: "1",
          SELECTED: "fixture",
        },
        timeoutMs: 10_000,
      },
    );
    expect([...output.stdout]).toEqual([0, 255, 42]);
    expect(new TextDecoder().decode(output.stderr)).toBe("fixture-error");
    expect(output.code).toBe(7);
    expect(output.signal).toBeNull();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("qualification rejects an unbounded deadline before spawning", async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5])
    await expect(
      runQualificationProcess(["-e", "throw new Error('must not spawn')"], {
        cwd: import.meta.dir,
        env: {},
        timeoutMs,
      }),
    ).rejects.toThrow("positive timeout");
});
