import { dns } from "bun";

export interface SourceProbe {
  url: string;
  host: string;
  port: number;
  addresses: string[];
  dnsMs: number;
  tcpMs: number;
  tlsMs?: number;
  status?: number;
  acceptRanges: boolean;
  contentType?: string;
  contentLength?: number;
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 10_000;

function withDeadline<T>(promise: Promise<T>, label: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Opens a TCP (optionally TLS) connection and reports the time to open and to complete the handshake. */
export async function connectTiming(
  hostname: string,
  port: number,
  tls: boolean,
): Promise<{ tcpMs: number; tlsMs?: number }> {
  const started = performance.now();
  const opened = await withDeadline(
    new Promise<number>((resolve, reject) => {
      Bun.connect({
        hostname,
        port,
        tls: tls ? { serverName: hostname } : undefined,
        socket: {
          open(socket) {
            const at = performance.now();
            if (!tls) {
              socket.end();
              resolve(at);
            }
          },
          handshake(socket, success, error) {
            if (!success) return reject(error ?? new Error("TLS handshake failed"));
            socket.end();
            resolve(performance.now());
          },
          data() {},
          error(_socket, error) {
            reject(error);
          },
          close() {},
          connectError(_socket, error) {
            reject(error);
          },
        },
      }).catch(reject);
    }),
    `connect ${hostname}:${port}`,
  );
  const tcpMs = Math.round(opened - started);
  return tls ? { tcpMs, tlsMs: Math.round(performance.now() - opened) } : { tcpMs };
}

/** Probes a media URL before download: DNS, TCP/TLS timing, then one ranged GET to read range support and size. */
export async function probeSource(input: string): Promise<SourceProbe> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("probeSource accepts http(s) URLs only");
  const tls = url.protocol === "https:";
  const port = Number(url.port || (tls ? 443 : 80));
  const base: SourceProbe = {
    url: url.href,
    host: url.hostname,
    port,
    addresses: [],
    dnsMs: 0,
    tcpMs: 0,
    acceptRanges: false,
    ok: false,
  };
  try {
    const dnsStarted = performance.now();
    const records = await withDeadline(dns.lookup(url.hostname, { backend: "system" }), `dns ${url.hostname}`);
    base.dnsMs = Math.round(performance.now() - dnsStarted);
    base.addresses = [...new Set(records.map(record => record.address))];
    const timing = await connectTiming(url.hostname, port, tls);
    base.tcpMs = timing.tcpMs;
    if (timing.tlsMs !== undefined) base.tlsMs = timing.tlsMs;
    const response = await withDeadline(
      fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "follow" }),
      `GET ${url.hostname}`,
    );
    await response.body?.cancel();
    base.status = response.status;
    base.acceptRanges = response.status === 206 || response.headers.get("accept-ranges") === "bytes";
    base.contentType = response.headers.get("content-type") ?? undefined;
    const total = response.headers.get("content-range")?.split("/")[1];
    const length = total && total !== "*" ? Number(total) : Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 0) base.contentLength = length;
    base.ok = (response.status >= 200 && response.status < 300) || response.status === 206;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}

/** Probes several sources concurrently, bounded by `concurrency`. */
export async function probeSources(urls: string[], concurrency = 4): Promise<SourceProbe[]> {
  const results: SourceProbe[] = new Array(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++;
      results[index] = await probeSource(urls[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface CrawlReport {
  schema: string;
  pages: Array<{ url: string; [key: string]: unknown }>;
  errors: Array<{ url: string; error: string }>;
  stats: Record<string, number>;
}

/** Parses an `aphrody-web crawl --format json` document; rejects any other schema. */
export function parseCrawlReport(text: string): CrawlReport {
  const report = JSON.parse(text) as CrawlReport;
  if (report.schema !== "aphrody-web.crawl/1" || !Array.isArray(report.pages) || !Array.isArray(report.errors))
    throw new TypeError("unexpected crawl report schema");
  return report;
}

const MEDIA_PATTERN = /\.(mp4|m4s|m3u8|mpd|webm|mkv|mov)(?:[?#]|$)/i;

/** Bounded, robots-aware discovery of media candidates from seed pages, then preflight of each candidate. */
export async function discoverSources(
  seeds: string[],
  options: { maxPages?: number; maxDepth?: number; timeoutSeconds?: number } = {},
): Promise<{ report: CrawlReport; candidates: SourceProbe[] }> {
  const args = [
    "crawl",
    "--format",
    "json",
    "--obey-robots",
    "--max-pages",
    String(options.maxPages ?? 25),
    "--max-depth",
    String(options.maxDepth ?? 1),
    "--timeout",
    String(options.timeoutSeconds ?? 120),
    ...seeds,
  ];
  const child = Bun.spawn(["aphrody-web", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`aphrody-web crawl failed (${code}): ${stderr.trim()}`);
  const report = parseCrawlReport(stdout);
  const urls = new Set<string>();
  for (const page of report.pages) if (MEDIA_PATTERN.test(page.url)) urls.add(page.url);
  for (const page of report.pages) {
    const links = Array.isArray(page.links) ? (page.links as unknown[]) : [];
    for (const link of links)
      if (typeof link === "string" && MEDIA_PATTERN.test(link)) urls.add(new URL(link, page.url).href);
  }
  const candidates = await probeSources([...urls], 4);
  return { report, candidates };
}
