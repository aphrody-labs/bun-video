import { executeVideoTask, type VideoRenderTask } from "./video-worker-task";

export async function runVideoWorkerEntry(taskPath: string, resultPath: string): Promise<number> {
  try {
    const task = (await Bun.file(taskPath).json()) as VideoRenderTask;
    const result = await executeVideoTask(task);
    await Bun.write(resultPath, JSON.stringify({ ok: true, result }, null, 2));
    return 0;
  } catch (error) {
    await Bun.write(
      resultPath,
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Video worker failed" }, null, 2),
    );
    return 1;
  }
}

if (import.meta.main) {
  const [taskPath, resultPath] = Bun.argv.slice(2);
  if (!taskPath || !resultPath || Bun.argv.length !== 4) {
    console.error("Usage: video-worker-entry <private-task.json> <private-result.json>");
    process.exitCode = 2;
  } else process.exitCode = await runVideoWorkerEntry(taskPath, resultPath);
}
