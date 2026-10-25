import type { YtDlpOptions, YtDlpResult } from "./ytdlp";

export interface XVideoSourceOptions {
  readonly ytdlp?: YtDlpOptions;
  readonly extract?: (url: string, options?: YtDlpOptions) => Promise<YtDlpResult>;
  readonly download?: (url: string, output: string, options?: YtDlpOptions) => Promise<YtDlpResult>;
}

export interface XVideoReference {
  readonly url: string;
  readonly statusId: string;
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

/** Accept public status URLs only; discard tracking query/hash data and URL credentials. */
export function normalizeXVideoUrl(input: string): XVideoReference {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("X video URL must be an absolute HTTP(S) status URL");
  }

  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password)
    throw new TypeError("X video URL must not contain credentials and must use HTTP(S)");

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!X_HOSTS.has(hostname)) throw new TypeError("URL is not an X status URL");

  const match = parsed.pathname.match(/^\/(?:i\/web\/|[^/]+\/)?status\/(\d+)(?:\/video\/\d+)?\/?$/i);
  if (!match) throw new TypeError("X video URL must point to a status");

  // The status ID is sufficient for yt-dlp's X extractor and avoids forwarding
  // usernames, tracking parameters, fragments, or potentially private query data.
  const statusId = match[1]!;
  return { statusId, url: `https://x.com/i/web/status/${statusId}` };
}

/** Typed X.com adapter over the shared yt-dlp extractor/downloader. */
export class XVideoSource {
  readonly #options: XVideoSourceOptions;

  constructor(options: XVideoSourceOptions = {}) {
    this.#options = options;
  }

  async metadata(input: string): Promise<YtDlpResult> {
    const reference = normalizeXVideoUrl(input);
    const extract = this.#options.extract ?? (await import("./ytdlp")).extractYtDlp;
    return extract(reference.url, { no_playlist: true, ...this.#options.ytdlp });
  }

  async download(input: string, output: string): Promise<YtDlpResult> {
    if (!output || output.includes("\0")) throw new TypeError("Output path must be a non-empty path without NUL");
    const reference = normalizeXVideoUrl(input);
    const download = this.#options.download ?? (await import("./ytdlp")).downloadYtDlp;
    return download(reference.url, output, { no_playlist: true, ...this.#options.ytdlp });
  }
}
