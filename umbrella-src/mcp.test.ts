import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { callVideoTool, registerVideoTools, videoTools } from "../src/mcp";

test("MCP rejects cancelled calls and native-incompatible FPS before loading media", async () => {
  await expect(callVideoTool("video_capabilities", {}, AbortSignal.abort())).rejects.toThrow();
  await expect(
    callVideoTool("video_encode", { plan: { fps: { num: 241, den: 1 } }, output: "unused" }),
  ).rejects.toThrow("FPS");
  await expect(
    callVideoTool("video_encode", {
      plan: { fps: { num: 4294967296, den: 4294967296 } },
      output: "unused",
    }),
  ).rejects.toThrow("FPS");
});

test("stdio protocol answers independent requests while an earlier tool awaits", async () => {
  const executable = process.env.BUN_VIDEO_TEST_EXECUTABLE ?? process.execPath;
  const args = process.env.BUN_VIDEO_TEST_EXECUTABLE
    ? [executable, "mcp"]
    : [
        executable,
        "-e",
        `import {serveMcp} from ${JSON.stringify(fileURLToPath(new URL("../src/mcp.ts", import.meta.url)))}; await serveMcp();`,
      ];
  const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "video_capabilities", arguments: {} },
    },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
  ];
  for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  await child.stdin.end();
  const replies = (await output)
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  expect(replies.map(reply => reply.id)).toEqual([1, 3, 2]);
  expect(replies[2].result.isError).toBe(true);
  expect(await errors).toBe("");
  expect(await child.exited).toBe(0);
}, 10000);

test("shared MCP routes actual interpolation and rejects malformed ranges", async () => {
  const result = await callVideoTool("video_remotion_interpolate", {
    frame: 5,
    inputRange: [0, 10],
    outputRange: [0, 100],
  });
  expect(result.structuredContent).toEqual({ value: 50 });
  expect(result.content[0]!.text).toBe('{"value":50}');
  await expect(
    callVideoTool("video_remotion_interpolate", {
      frame: 5,
      inputRange: [0, 10],
      outputRange: [0],
    }),
  ).rejects.toThrow();
  await expect(
    callVideoTool("video_hyperframes_spring", { mass: 1, stiffness: 1, damping: 1, steps: 0 }),
  ).rejects.toThrow();
});

test("canonical registration preserves all handlers and schemas", () => {
  const registered: string[] = [];
  registerVideoTools((tool, handler) => {
    registered.push(tool.name);
    expect(typeof handler).toBe("function");
  });
  expect(registered).toEqual(videoTools.map(tool => tool.name));
});
