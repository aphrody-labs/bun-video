import { createInterface } from "node:readline";
import { interpolate } from "./render-runtime";
import { generateSpringEaseData } from "./render-runtime";

const array = { type: "array", minItems: 2, maxItems: 1024, items: { type: "number" } };
export const framePlanSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["remotion", "hyperframes"] },
    compositionUrl: { type: "string", format: "uri", pattern: "^https?://" },
    composition: { type: "string", minLength: 1 },
    fps: {
      type: "object",
      properties: {
        num: { type: "integer", minimum: 1, maximum: 4294967295 },
        den: { type: "integer", minimum: 1, maximum: 4294967295 },
      },
      required: ["num", "den"],
      additionalProperties: false,
      description: "Exact rational FPS; num / den must be at most 240",
    },
    startFrame: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    endFrame: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    width: { type: "integer", minimum: 1, maximum: 7680 * 4320 },
    height: { type: "integer", minimum: 1, maximum: 7680 * 4320 },
    workers: { type: "integer", minimum: 1, maximum: 16 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
    libraryPath: { type: "string" },
    allowPrivateNetwork: { type: "boolean" },
  },
  required: ["kind", "compositionUrl", "fps", "startFrame", "endFrame", "width", "height"],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { kind: { const: "remotion" } }, required: ["kind"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a callable then.
      then: { required: ["composition"] },
    },
  ],
  description:
    "1..100000 frames, endFrame > startFrame; width * height <= 33177600. Cross-field bounds are checked at runtime.",
} as const;
export const videoTools = [
  {
    name: "video_encode",
    description:
      "Stream a served composition through bounded native workers into lossless FFV1; requires qualified embedded browser and media capabilities",
    inputSchema: {
      type: "object",
      properties: {
        plan: framePlanSchema,
        output: { type: "string", minLength: 1, description: "Absolute output path" },
      },
      required: ["plan", "output"],
      additionalProperties: false,
    },
  },
  {
    name: "video_capabilities",
    description: "Pinned upstreams, actual Bun revision and native browser provider probe",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "video_browser_task",
    description:
      "Isolated native browser navigation, DOM evaluation and screenshot for a local agent; requires a qualified browser provider",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        expression: { type: "string", maxLength: 32768 },
        screenshot: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "video_remotion_interpolate",
    description: "Actual Remotion frame interpolation, with clamped endpoints",
    inputSchema: {
      type: "object",
      properties: { frame: { type: "number" }, inputRange: array, outputRange: array },
      required: ["frame", "inputRange", "outputRange"],
      additionalProperties: false,
    },
  },
  {
    name: "video_hyperframes_spring",
    description: "Actual HyperFrames oscillator SVG curve",
    inputSchema: {
      type: "object",
      properties: {
        mass: { type: "number", exclusiveMinimum: 0 },
        stiffness: { type: "number", exclusiveMinimum: 0 },
        damping: { type: "number", exclusiveMinimum: 0 },
        steps: { type: "integer", minimum: 1, maximum: 4096 },
      },
      required: ["mass", "stiffness", "damping"],
      additionalProperties: false,
    },
  },
] as const;

function finite(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${key} must be finite`);
  return value;
}

export async function callVideoTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const definition = videoTools.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown video tool: ${name}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object");
  const properties = "properties" in definition.inputSchema ? definition.inputSchema.properties : {};
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new TypeError("Unknown tool argument");
  let result: unknown;
  if (name === "video_encode") {
    if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan) || typeof args.output !== "string")
      throw new TypeError("Frame plan object and absolute output required");
    const plan = args.plan as Record<string, unknown>;
    if (Object.keys(plan).some(key => !Object.hasOwn(framePlanSchema.properties, key)))
      throw new TypeError("Unknown frame plan property");
    const fps = plan.fps as Record<string, unknown> | undefined;
    if (
      !fps ||
      typeof fps !== "object" ||
      Array.isArray(fps) ||
      Object.keys(fps).some(key => key !== "num" && key !== "den")
    )
      throw new TypeError("Rational FPS object required");
    const num = finite(fps.num, "fps.num"),
      den = finite(fps.den, "fps.den");
    if (![num, den].every(value => Number.isInteger(value) && value > 0 && value <= 4294967295) || num / den > 240)
      throw new RangeError("FPS must use positive u32 components and be at most 240");
    if (
      (plan.allowPrivateNetwork !== undefined && typeof plan.allowPrivateNetwork !== "boolean") ||
      (plan.libraryPath !== undefined && typeof plan.libraryPath !== "string")
    )
      throw new TypeError("Invalid browser provider options");
    const { mediaAssets } = await import("bun-video:media-runtime");
    const { encodeVideo } = await import("./encode");
    result = await encodeVideo(
      args.plan as import("./frame-plan").FramePlan,
      { ...mediaAssets, output: args.output },
      signal,
    );
  } else if (name === "video_capabilities") {
    result = await import("./capabilities").then(mod => mod.productCapabilities());
  } else if (name === "video_browser_task") {
    if (typeof args.url !== "string" || (args.screenshot !== undefined && typeof args.screenshot !== "boolean"))
      throw new TypeError("URL string and screenshot boolean required");
    result = await import("./computer").then(mod =>
      mod.runBrowserTask(
        {
          url: args.url as string,
          expression: args.expression as string | undefined,
          screenshot: args.screenshot as boolean | undefined,
          timeoutMs: args.timeoutMs as number | undefined,
        },
        signal,
      ),
    );
  } else if (name === "video_remotion_interpolate") {
    const inputRange = args.inputRange,
      outputRange = args.outputRange;
    if (
      !Array.isArray(inputRange) ||
      !Array.isArray(outputRange) ||
      inputRange.length !== outputRange.length ||
      inputRange.length < 2 ||
      inputRange.length > 1024
    )
      throw new RangeError("Ranges must have equal lengths in 2..1024");
    inputRange.forEach(value => finite(value, "inputRange"));
    outputRange.forEach(value => finite(value, "outputRange"));
    result = {
      value: interpolate(finite(args.frame, "frame"), inputRange, outputRange, {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    };
  } else {
    const mass = finite(args.mass, "mass"),
      stiffness = finite(args.stiffness, "stiffness"),
      damping = finite(args.damping, "damping");
    const steps = args.steps === undefined ? 120 : finite(args.steps, "steps");
    if (mass <= 0 || stiffness <= 0 || damping <= 0 || !Number.isInteger(steps) || steps < 1 || steps > 4096)
      throw new RangeError("Positive spring parameters and integer steps 1..4096 required");
    result = { path: generateSpringEaseData(mass, stiffness, damping, steps) };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** Register the same schemas and handlers in the canonical capability owner. */
export function registerVideoTools(
  register: (
    tool: (typeof videoTools)[number],
    handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  ) => void,
) {
  for (const tool of videoTools) register(tool, (args, signal) => callVideoTool(tool.name, args, signal));
}

export async function serveMcp() {
  let initialized = false;
  const active = new Map<string | number, AbortController>();
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  for await (const line of lines) {
    if (new TextEncoder().encode(line).length > 1024 * 1024) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds 1 MiB" } });
      continue;
    }
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      send({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      continue;
    }
    if (!Object.hasOwn(request, "id")) {
      if (request.method === "notifications/cancelled") {
        const requestId = request.params?.requestId;
        active.get(requestId)?.abort(new Error("MCP request cancelled"));
      }
      continue;
    }
    const id = request.id;
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request id" } });
      continue;
    }
    let result: unknown;
    if (request.method === "initialize") {
      initialized = true;
      const requested = request.params?.protocolVersion;
      result = {
        protocolVersion: ["2025-11-25", "2025-06-18", "2024-11-05"].includes(requested) ? requested : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "bun-video", version: "0.1.0" },
      };
    } else if (request.method === "ping") result = {};
    else if (!initialized) {
      send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Initialize first" } });
      continue;
    } else if (request.method === "tools/list") result = { tools: videoTools };
    else if (request.method === "tools/call") {
      if (active.has(id) || active.size >= 16) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: active.has(id) ? "Duplicate active request id" : "At most 16 active tool calls are permitted",
          },
        });
        continue;
      }
      const controller = new AbortController();
      active.set(id, controller);
      const task = (async () => {
        let toolResult: unknown;
        try {
          toolResult = await callVideoTool(request.params?.name, request.params?.arguments, controller.signal);
          controller.signal.throwIfAborted();
        } catch (error) {
          toolResult = { isError: true, content: [{ type: "text", text: String(error) }] };
        } finally {
          active.delete(id);
        }
        send({ jsonrpc: "2.0", id, result: toolResult });
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      continue;
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      continue;
    }
    send({ jsonrpc: "2.0", id, result });
  }
  for (const controller of active.values()) controller.abort(new Error("MCP stdin closed"));
  await Promise.allSettled(pending);
}
