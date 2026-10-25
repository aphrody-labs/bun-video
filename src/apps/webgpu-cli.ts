#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import {
  nativeWebGpuInfo,
  openWindowsWebGpuDesktop,
  probeChromiumWebGpu,
  runWebGpuJob,
  type WebGpuOptions,
} from "../webgpu";

function usage(): never {
  console.log(`bun-video webgpu <command>

Commands:
  info [--library <path>]                         Inspect the native wgpu/CUDA provider
  probe                                           Probe WebGPU in headless Chromium
  run <shader.wgsl> <input.bin> <output.bin> [--backend native|chromium]
      [--workgroups x,y,z] [--entry identifier] [--library <path>]
  desktop                                         Open the native Windows desktop WebGPU probe

Linux serverless jobs use BUV_RUNTIME_LIB or YOLO_RUNTIME_LIB pointing to a GPU-enabled
runtime artifact (ABI 1.5). `);
  process.exit(0);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export async function main(args: string[]): Promise<void> {
  const command = args.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") usage();

  if (command === "info") {
    const libraryPath = option(args, "--library");
    if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
    console.log(JSON.stringify(await nativeWebGpuInfo(libraryPath ? { libraryPath } : {}), null, 2));
    return;
  }

  if (command === "probe") {
    if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
    const report = await probeChromiumWebGpu();
    console.log(JSON.stringify(report, null, 2));
    if (!report.adapter) process.exitCode = 2;
    return;
  }

  if (command === "run") {
    const shaderPath = args.shift();
    const inputPath = args.shift();
    const outputPath = args.shift();
    if (!shaderPath || !inputPath || !outputPath) usage();
    const backend = option(args, "--backend") ?? "native";
    const workgroups = (option(args, "--workgroups") ?? "1,1,1").split(",").map(Number);
    const entryPoint = option(args, "--entry");
    const libraryPath = option(args, "--library");
    if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
    if (workgroups.length !== 3 || workgroups.some(value => !Number.isSafeInteger(value)))
      throw new Error("--workgroups must be three comma-separated integers");
    if (backend !== "native" && backend !== "chromium") throw new Error("--backend must be native or chromium");
    const options: WebGpuOptions = {
      backend,
      ...(libraryPath === undefined ? {} : { libraryPath }),
    };
    const result = await runWebGpuJob(
      {
        shader: await Bun.file(shaderPath).text(),
        data: new Uint8Array(await readFile(inputPath)),
        workgroups: workgroups as [number, number, number],
        ...(entryPoint === undefined ? {} : { entryPoint }),
      },
      options,
    );
    await writeFile(outputPath, result.data);
    console.log(
      JSON.stringify({ backend, bytes: result.data.byteLength, elapsedMs: result.elapsedMs, output: outputPath }),
    );
    return;
  }

  if (command === "desktop") {
    if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);
    const app = await openWindowsWebGpuDesktop();
    console.log(`Bun Video WebGPU desktop window: ${app.url}`);
    const report = await Promise.race([app.result, app.closed.then(() => null)]);
    if (report) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.adapter) process.exitCode = 2;
    }
    await app.closed;
    await app.close();
    return;
  }

  usage();
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = main;
