#!/usr/bin/env bun
import { openConfiguredUnifiedVideoPipeline } from "../video-workflow";
import { inspectVideoAPI, type VideoAPIFamily } from "../video-api";
import type { VideoRenderTask } from "../video-worker-task";
import type { VideoDatasetExportResult } from "../video-dataset";
import { resolve } from "node:path";

export async function videoWorkersMain(args = Bun.argv.slice(2)) {
  if (args[0] === "--video-worker") {
    const { runVideoWorkerEntry } = await import("../video-worker-entry");
    if (args.length !== 3) throw new Error("Worker requires private request and result paths");
    process.exitCode = await runVideoWorkerEntry(args[1]!, args[2]!);
    return;
  }
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cdxURLs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--help" || value === "-h") {
      positional.unshift("help");
      continue;
    }
    if (value.startsWith("--")) {
      if (value === "--include-text") {
        values.set(value, "true");
        continue;
      }
      if (value === "--cdx-url") {
        if (!args[index + 1] || args[index + 1]!.startsWith("--"))
          throw new Error("--cdx-url requires a real source URL");
        cdxURLs.push(args[++index]!);
        continue;
      }
      if (
        !["--db", "--workers", "--timeout-ms", "--endpoint", "--probe", "--output", "--format", "--source-id"].includes(
          value,
        ) ||
        !args[index + 1]
      )
        throw new Error("Unknown or incomplete video worker option");
      values.set(value, args[++index]!);
    } else positional.push(value);
  }
  const [command = "help", input] = positional;
  if (command === "help") {
    console.log(
      "bun-video workers init|sources|apis [--probe family]|import-capture capture.har|run jobs.json|sites sites.json|archive-capture [archive-URL]|export <output>|publish <private-directory>\n--db path.sqlite --workers 1..4 --timeout-ms 1..3600000 --endpoint local-CDP\narchive-capture: --output path.har --cdx-url real-source-URL (maximum 3)\nexport: --format json|jsonl|sql|wiki --include-text --source-id sourceId\npublish: --include-text; curated catalog and exports through Bun Cloudflare R2\nAcquisition sites réels dans le profil Chrome original ; HAR Archive HTTP borné distinct du navigateur ; données et diagnostics privés.",
    );
    return;
  }
  await using pipeline = await openConfiguredUnifiedVideoPipeline({
    dbPath: values.get("--db"),
    workers: Number(values.get("--workers") ?? 2),
    timeoutMs: Number(values.get("--timeout-ms") ?? 300000),
  });
  switch (command) {
    case "init":
      console.log(JSON.stringify(await pipeline.initialize()));
      break;
    case "sources":
      console.log(
        JSON.stringify({
          sources: await pipeline.catalog.listSources(),
          jobs: await pipeline.catalog.listJobs(),
          qualifications: await pipeline.catalog.listQualifications(),
        }),
      );
      break;
    case "apis":
      console.log(
        JSON.stringify(
          values.has("--probe") ? await inspectVideoAPI(values.get("--probe") as VideoAPIFamily) : pipeline.apis(),
        ),
      );
      break;
    case "import-capture":
      if (!input) throw new Error("import-capture requires a private HAR path");
      console.log(JSON.stringify(await pipeline.importCapture(input)));
      break;
    case "archive-capture": {
      const capture = await pipeline.archiveCapture({ url: input, output: values.get("--output"), cdxURLs });
      const imported = await pipeline.importCapture(capture.path);
      console.log(JSON.stringify({ capture, imported }));
      break;
    }
    case "export": {
      const output = values.get("--output") ?? input;
      if (!output) throw new Error("export requires an output path");
      const format = values.get("--format") ?? "json";
      if (!["json", "jsonl", "sql", "wiki"].includes(format)) throw new Error("Unknown dataset export format");
      console.log(
        JSON.stringify(
          await pipeline.exportDataset({
            output: resolve(output),
            format: format as VideoDatasetExportResult["format"],
            includeText: values.has("--include-text"),
            sourceId: values.get("--source-id"),
          }),
        ),
      );
      break;
    }
    case "publish":
      if (!input) throw new TypeError("publish requires an absolute private generation directory");
      console.log(
        JSON.stringify(
          await pipeline.publish({ outputDirectory: resolve(input), includeText: values.has("--include-text") }),
        ),
      );
      break;
    case "run": {
      if (!input) throw new Error("run requires a private jobs JSON file");
      const tasks: unknown = await Bun.file(input).json();
      if (!Array.isArray(tasks) || !tasks.length || tasks.length > 1000)
        throw new TypeError("jobs JSON must contain 1..1000 render tasks");
      const results = await Promise.allSettled(tasks.map(task => pipeline.render(task as VideoRenderTask)));
      console.log(
        JSON.stringify(
          results.map(result =>
            result.status === "fulfilled"
              ? {
                  status: "completed",
                  output: result.value.output,
                  frames: result.value.frames,
                  bytes: result.value.bytes,
                  sha256: result.value.sha256,
                }
              : { status: "failed", error: String(result.reason) },
          ),
        ),
      );
      if (results.some(result => result.status === "rejected")) process.exitCode = 1;
      break;
    }
    case "sites": {
      const urls = input ? await Bun.file(input).json() : ["https://www.crunchyroll.com/"];
      if (!Array.isArray(urls) || !urls.every(value => typeof value === "string"))
        throw new TypeError("sites JSON must contain real site URLs");
      const results = await pipeline.qualifySites(urls, { endpoint: values.get("--endpoint") });
      console.log(JSON.stringify(results));
      if (results.some(result => result.status !== "passed")) process.exitCode = 1;
      break;
    }
    default:
      throw new Error("Unknown video worker command");
  }
}
if (import.meta.main) await videoWorkersMain();

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = videoWorkersMain;
