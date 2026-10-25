import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ArchiveCaptureOptions {
  url?: string;
  output?: string;
  cdxURLs?: readonly string[];
  maxResources?: number;
  maxDomains?: number;
  maxBodyBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ArchiveCaptureSummary {
  path: string;
  coverage: "http";
  complete: boolean;
  entries: number;
  bytes: number;
  failures: number;
  truncated: number;
  omissions: string[];
}

export function archiveCDXURL(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new TypeError("Public HTTP(S) CDX target required");
  const request = new URL("https://web.archive.org/cdx/search/cdx");
  request.search = new URLSearchParams({
    url: url.href,
    output: "json",
    limit: "3",
    fl: "timestamp,original,mimetype,statuscode,digest,length",
    collapse: "digest",
  }).toString();
  return request.href;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max)
    throw new RangeError("Archive capture limit outside bounds");
  return result;
}

function allowedURL(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(url.hostname === "archive.org" || url.hostname.endsWith(".archive.org"))
  )
    throw new TypeError("Archive HTTP capture is limited to HTTPS archive.org origins");
  url.hash = "";
  return url.href;
}

function resourceURL(value: string): string | null {
  const url = new URL(value);
  if (url.protocol === "data:" || (url.hash && !url.pathname)) return null;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) ||
    /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
    url.hostname.includes(":")
  )
    throw new TypeError("Only discovered public HTTPS resources are captured");
  url.hash = "";
  return url.href;
}

/** Public archive and discovered asset HTTP graph; no JavaScript, browser profile or cookies. */
export async function captureArchiveHTTP(options: ArchiveCaptureOptions = {}): Promise<ArchiveCaptureSummary> {
  const url = allowedURL(options.url ?? "https://web.archive.org/");
  if ((options.cdxURLs?.length ?? 0) > 3) throw new RangeError("At most three explicit CDX targets");
  const maxResources = boundedInteger(options.maxResources, 250, 250);
  const maxDomains = boundedInteger(options.maxDomains, 16, 16);
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, 32 * 1024 * 1024, 32 * 1024 * 1024);
  const maxTotalBytes = boundedInteger(options.maxTotalBytes, 128 * 1024 * 1024, 128 * 1024 * 1024);
  const timeoutMs = boundedInteger(options.timeoutMs, 20000, 20000);
  const home = options.output
    ? ""
    : (Bun.env.APHRODY_HOME ??
      join(
        Bun.env.USERPROFILE ??
          Bun.env.HOME ??
          (() => {
            throw new Error("Explicit output or Aphrody home required");
          })(),
        ".aphrody",
      ));
  const output = resolve(options.output ?? join(home, "cookies", "archive-capture", "web.archive.org.har"));
  const entries: Record<string, any>[] = [];
  const queue = [url, ...(options.cdxURLs ?? []).map(archiveCDXURL)];
  const seen = new Set<string>();
  const domains = new Set<string>();
  const omissions = new Set<string>([
    "JavaScript requests, browser cache/service workers, cookies and browser timing are outside HTTP coverage",
  ]);
  let limited = 0;
  let bytes = 0,
    failures = 0,
    truncated = 0,
    excluded = 0;
  const enqueue = (value: string, base: string) => {
    try {
      if (value.startsWith("#")) return;
      const candidate = resourceURL(new URL(value, base).href);
      if (!candidate) return;
      if (!seen.has(candidate) && !queue.includes(candidate)) {
        if (queue.length + seen.size >= maxResources) limited++;
        else queue.push(candidate);
      }
    } catch {
      excluded++;
    }
  };
  while (queue.length && seen.size < maxResources) {
    options.signal?.throwIfAborted();
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    const hostname = new URL(current).hostname;
    if (!domains.has(hostname) && domains.size >= maxDomains) {
      excluded++;
      continue;
    }
    domains.add(hostname);
    seen.add(current);
    const began = performance.now(),
      startedDateTime = new Date().toISOString();
    const requestHeaders = { Accept: "*/*", "User-Agent": "Aphrody-Bun-Archive-Capture/1.0" };
    const entry: Record<string, any> = {
      startedDateTime,
      time: 0,
      request: {
        method: "GET",
        url: current,
        httpVersion: "",
        cookies: [],
        headers: Object.entries(requestHeaders).map(([name, value]) => ({ name, value })),
        queryString: [...new URL(current).searchParams].map(([name, value]) => ({ name, value })),
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 0,
        statusText: "",
        httpVersion: "",
        cookies: [],
        headers: [],
        content: { size: 0, mimeType: "application/octet-stream", text: "", encoding: "base64" },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 },
    };
    entries.push(entry);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    try {
      const response = await fetch(current, {
        headers: requestHeaders,
        redirect: "manual",
        credentials: "omit",
        signal,
      });
      const headersAt = performance.now();
      entry.timings.wait = headersAt - began;
      Object.assign(entry.response, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers].map(([name, value]) => ({ name, value })),
        redirectURL: response.headers.get("location") ?? "",
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      const abort = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (reader) {
          signal.throwIfAborted();
          const read = await reader.read();
          signal.throwIfAborted();
          if (read.done) break;
          const remaining = Math.min(maxBodyBytes - size, maxTotalBytes - bytes);
          const portion = read.value.subarray(0, Math.max(0, remaining));
          chunks.push(portion.slice());
          size += portion.length;
          bytes += portion.length;
          if (portion.length !== read.value.length) {
            entry._truncated = true;
            truncated++;
            await reader.cancel();
            break;
          }
        }
      } catch (error) {
        entry._incomplete = true;
        entry._error = error instanceof Error ? error.message : "Response body failed";
        failures++;
      } finally {
        signal.removeEventListener("abort", abort);
        reader?.releaseLock();
      }
      const body = Buffer.concat(chunks);
      const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
      entry.response.content = { size, mimeType, text: body.toString("base64"), encoding: "base64" };
      entry.response.bodySize = size;
      entry.timings.receive = performance.now() - headersAt;
      if (response.status >= 400) failures++;
      if (response.status >= 300 && response.status < 400 && entry.response.redirectURL)
        enqueue(entry.response.redirectURL, current);
      if (!entry._truncated && !entry._incomplete && mimeType === "text/html") {
        const rewritten = new HTMLRewriter()
          .on("script[src],img[src],source[src],iframe[src],link[href]", {
            element(element) {
              const attr = element.tagName === "link" ? "href" : "src";
              if (
                element.tagName === "link" &&
                !/stylesheet|preload|modulepreload|icon/.test(element.getAttribute("rel") ?? "")
              )
                return;
              const value = element.getAttribute(attr);
              if (value) enqueue(value, current);
            },
          })
          .transform(new Response(body));
        await rewritten.arrayBuffer();
      } else if (!entry._truncated && !entry._incomplete && mimeType === "text/css") {
        for (const match of body.toString().matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s*["']([^"']+)["']/g))
          enqueue(match[1] ?? match[2]!, current);
      }
    } catch (error) {
      failures++;
      entry._error = error instanceof Error ? error.message : "HTTP request failed";
    }
    if ((entry._error || entry.response.status >= 400) && new URL(current).pathname === "/cdx/search/cdx") {
      const original = new URL(current).searchParams.get("url");
      if (original) {
        const alternative = new URL("https://web.archive.org/web/timemap/json");
        alternative.search = new URLSearchParams({
          url: original,
          limit: "3",
          matchType: "exact",
          collapse: "digest",
        }).toString();
        enqueue(alternative.href, current);
      }
    }
    entry.time = performance.now() - began;
    if (bytes >= maxTotalBytes) {
      omissions.add("Total body byte limit reached");
      break;
    }
  }
  if (queue.length) omissions.add(`${queue.length} discovered requests omitted by resource or total-byte limit`);
  if (limited) omissions.add(`${limited} discovered requests omitted by the bounded resource frontier`);
  if (excluded) omissions.add(`${excluded} discovered URLs outside the public HTTPS or domain scope`);
  if (truncated) omissions.add(`${truncated} response bodies truncated`);
  const summary: ArchiveCaptureSummary = {
    path: output,
    coverage: "http",
    complete: !failures && !truncated && !queue.length && !excluded && !limited,
    entries: entries.length,
    bytes,
    failures,
    truncated,
    omissions: [...omissions],
  };
  const har = {
    log: {
      version: "1.2",
      creator: { name: "Aphrody Bun HTTP archive collector", version: "1.0" },
      entries,
      _capture: {
        ...summary,
        scope: "explicit public archive URLs and their statically discovered public HTTPS resources",
        javascriptExecuted: false,
        browserProfileAttached: false,
      },
    },
  };
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify(har));
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return summary;
}
