// SPDX-License-Identifier: Apache-2.0
import { inspectDashManifest } from "../dash";

export interface DashLiveConfig {
  src: string;
  allowedOrigins: string[];
  headersByOrigin: Record<string, Record<string, string>>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function httpUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("Live DASH URL must be a string.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid live DASH URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Live DASH URLs require HTTP(S), no embedded credentials or fragment.");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Live DASH transport requires HTTPS outside loopback tests.");
  return url;
}
function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("Live DASH headers must be a string record.");
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      typeof content !== "string" ||
      /[\r\n]/.test(content) ||
      content.includes("\0") ||
      /^(?:host|content-length|connection|transfer-encoding|upgrade|proxy-.*|te|trailer)$/i.test(name)
    )
      throw new Error("Invalid or transport-managed live DASH header.");
    result[name.toLowerCase()] = content;
  }
  return result;
}

export function validateDashLiveConfig(value: unknown): DashLiveConfig {
  if (!record(value) || !Array.isArray(value.allowedOrigins) || !value.allowedOrigins.length)
    throw new Error("Live DASH config requires explicit allowedOrigins.");
  if (Object.hasOwn(value, "protectionData"))
    throw new Error("Live DASH laboratory transport supports media only; protectionData is unsupported.");
  const allowedOrigins = [
    ...new Set(
      value.allowedOrigins.map(origin => {
        const url = httpUrl(origin);
        if (url.pathname !== "/" || url.search)
          throw new Error("Allowed origins must contain only scheme, host and port.");
        return url.origin;
      }),
    ),
  ];
  const src = httpUrl(value.src);
  if (!allowedOrigins.includes(src.origin)) throw new Error("Live DASH source origin is not authorized.");
  if (/licen[cs]|widevine|playready/i.test(src.hostname + src.pathname))
    throw new Error("Live DASH source must be a media manifest resource.");
  const headersByOrigin: DashLiveConfig["headersByOrigin"] = {};
  if (value.headersByOrigin !== undefined && !record(value.headersByOrigin))
    throw new Error("Invalid headersByOrigin config.");
  for (const [origin, values] of Object.entries(value.headersByOrigin ?? {})) {
    const url = httpUrl(origin);
    if (url.href !== `${url.origin}/` || !allowedOrigins.includes(url.origin))
      throw new Error("Header origin is not explicitly authorized.");
    headersByOrigin[url.origin] = headers(values);
  }
  return { src: src.href, allowedOrigins, headersByOrigin };
}

type Resource = { url: string };
export interface DashLiveTransportOptions {
  timeoutMs?: number;
  maxManifestBytes?: number;
}

async function boundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new Error("Live DASH request timed out.");
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Live DASH response exceeds the configured byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

export function createDashLiveTransport(input: DashLiveConfig, options: DashLiveTransportOptions = {}) {
  const config = validateDashLiveConfig(input);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxManifestBytes = options.maxManifestBytes ?? 5 * 1024 * 1024;
  if (![timeoutMs, maxManifestBytes].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error("Live DASH transport limits must be positive integers.");
  const resources = new Map<string, Resource>();
  function authorized(value: string): URL {
    const url = httpUrl(value);
    if (!config.allowedOrigins.includes(url.origin)) throw new Error("Live DASH resource origin is not authorized.");
    return url;
  }
  function register(resource: Resource): string {
    for (const [token, current] of resources) if (current.url === resource.url) return token;
    const token = crypto.randomUUID();
    resources.set(token, resource);
    return token;
  }
  const sourceToken = register({ url: config.src });
  function resourceToken(value: string): string {
    const url = authorized(value);
    if (/licen[cs]|widevine|playready/i.test(url.hostname + url.pathname))
      throw new Error("Live DASH laboratory transport supports media resources only.");
    return register({ url: url.href });
  }

  async function remote(resource: Resource, request?: Request) {
    const url = authorized(resource.url);
    const method = request?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      throw new Error("Live DASH request method is not authorized for this resource.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = () => clearTimeout(timer);
    try {
      const originHeaders = new Headers(config.headersByOrigin[url.origin]);
      const range = request?.headers.get("range");
      if (range) {
        if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new Error("Unsupported live DASH byte range.");
        originHeaders.set("range", range);
      }
      const response = await fetch(url, {
        method,
        headers: originHeaders,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Live DASH redirects are not authorized.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Live DASH remote request failed.");
      }
      return { response, done, controller };
    } catch (error) {
      done();
      if (controller.signal.aborted) throw new Error("Live DASH request timed out.");
      if (
        (error instanceof Error && error.message.startsWith("Live DASH")) ||
        (error instanceof Error && error.message.startsWith("Unsupported live DASH"))
      )
        throw error;
      throw new Error("Live DASH transport request failed.");
    }
  }

  async function fetchSource(): Promise<{ text: string; baseURL: string }> {
    const { response, done, controller } = await remote(resources.get(sourceToken)!);
    try {
      const text = new TextDecoder().decode(await boundedBody(response.body, maxManifestBytes, controller.signal));
      inspectDashManifest(text);
      return { text, baseURL: config.src };
    } catch {
      throw new Error(
        controller.signal.aborted ? "Live DASH request timed out." : "Live DASH source is not a valid bounded MPD.",
      );
    } finally {
      done();
    }
  }

  async function fetchResource(token: string, request?: Request): Promise<Response> {
    const resource = resources.get(token);
    if (!resource) throw new Error("Unknown live DASH resource token.");
    const { response, done, controller } = await remote(resource, request);
    const outgoing = new Headers();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!/^(?:video\/|audio\/|application\/(?:octet-stream|mp4)(?:;|$))/i.test(contentType)) {
      done();
      await response.body?.cancel();
      throw new Error("Live DASH manifests require local rewriting; non-media response refused.");
    }
    outgoing.set("content-type", contentType);
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (
        value &&
        (name === "content-length"
          ? /^\d+$/.test(value)
          : name === "content-range"
            ? /^bytes \d+-\d+\/(?:\d+|\*)$/.test(value)
            : value === "bytes")
      )
        outgoing.set(name, value);
    }
    if (!response.body) {
      done();
      return new Response(null, { status: response.status, headers: outgoing });
    }
    const reader = response.body.getReader();
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        done();
        reader.releaseLock();
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const { value, done: complete } = await reader.read();
          if (complete) {
            finish();
            target.close();
          } else target.enqueue(value);
        } catch {
          finish();
          target.error(
            new Error(controller.signal.aborted ? "Live DASH request timed out." : "Live DASH response stream failed."),
          );
        }
      },
      async cancel() {
        controller.abort();
        try {
          await reader.cancel();
        } finally {
          finish();
        }
      },
    });
    return new Response(stream, { status: response.status, headers: outgoing });
  }

  async function proxy(value: string, request: Request): Promise<Response> {
    const url = authorized(value);
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new Error("Live DASH request method is not authorized for this resource.");
    return fetchResource(resourceToken(url.href), request);
  }

  async function rewriteDashManifest(
    xml: string,
    baseURL: string,
    urlForToken: (token: string) => string,
  ): Promise<string> {
    inspectDashManifest(xml);
    const parsed = Bun.XML.parse(xml) as Record<string, unknown>;
    let baseCount = 0;
    const visit = (node: Record<string, unknown>, base: string) => {
      const baseKeys = Object.keys(node).filter(name => name.split(":").at(-1) === "BaseURL");
      let currentBase = base;
      if (baseKeys.length > 1) throw new Error("Live DASH replay supports a single BaseURL per manifest node.");
      for (const name of baseKeys) {
        const value = node[name];
        if (typeof value !== "string" || !value.trim())
          throw new Error("Live DASH replay requires simple BaseURL elements.");
        const decoded = value.trim();
        try {
          currentBase = new URL(decoded, base).href;
        } catch {
          throw new Error("Invalid live DASH BaseURL.");
        }
        node[name] = urlForToken(resourceToken(currentBase));
        baseCount++;
      }
      for (const [name, value] of Object.entries(node)) {
        const local = name.split(":").at(-1);
        if (
          [
            "SegmentTemplate",
            "SegmentList",
            "Location",
            "PatchLocation",
            "UTCTiming",
            "Laurl",
            "laurl",
            "License",
            "LicenseURL",
          ].includes(local!)
        )
          throw new Error("Live DASH laboratory supports only SegmentBase manifests without external references.");
        if (name.startsWith("@")) {
          const attributeName = name.slice(1).split(":").at(-1)?.toLowerCase();
          if (
            ["href", "url", "sourceurl", "media", "initialization"].includes(attributeName!) ||
            (typeof value === "string" &&
              /https?:\/\//i.test(value) &&
              !name.startsWith("@xmlns") &&
              attributeName !== "schemeiduri")
          )
            throw new Error("Live DASH external manifest attributes are unsupported.");
          continue;
        }
        if (local === "BaseURL") continue;
        if (record(value)) visit(value, currentBase);
        else if (Array.isArray(value)) {
          for (const child of value) if (record(child)) visit(child, currentBase);
        } else if (typeof value === "string" && /https?:\/\//i.test(value))
          throw new Error("Live DASH unsupported remote manifest reference.");
      }
    };
    visit(parsed, baseURL);
    if (!baseCount) throw new Error("Live DASH laboratory requires captured-style BaseURL resources.");
    const rewritten = Bun.XML.stringify(parsed);
    if (!rewritten) throw new Error("Live DASH manifest rewrite produced no document.");
    return rewritten;
  }

  return { sourceToken, resourceToken, fetchSource, fetchResource, proxy, rewriteDashManifest };
}
