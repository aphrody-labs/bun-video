import { expect, test } from "bun:test";

test.each(["hyperframes", "remotion"])("%s workload is deterministic in independent processes", async project => {
  const run = async () => {
    await using child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/worker.ts`, project, `${import.meta.dir}/../${project}`],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, BUN_VIDEO_BENCH_ITERATIONS: "12" },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  const [first, second] = await Promise.all([run(), run()]);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(first.checksum).toBeGreaterThan(0);
  expect(first.elapsedMs).toBeGreaterThan(0);
  expect(second.digest).toBe(first.digest);
  expect(second.checksum).toBe(first.checksum);
});
