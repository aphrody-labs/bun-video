export interface ShowcaseBucketObject {
  size: number;
  httpEtag: string;
  body?: ReadableStream<Uint8Array>;
  range?: { offset: number; length: number };
  writeHttpMetadata(headers: Headers): void;
}

export interface ShowcaseEnvironment {
  SHOWCASE_PREFIX: string;
  /** HTTPS origin of the same-origin Bun.serve application. Keep it behind the Cloudflare network boundary. */
  BUN_VIDEO_BACKEND_URL?: string;
  /** Cloudflare Access team issuer, for example https://team.cloudflareaccess.com. */
  BUN_VIDEO_ACCESS_ISSUER?: string;
  /** Cloudflare Access application audience for private Bun Video routes. */
  BUN_VIDEO_ACCESS_AUD?: string;
  SHOWCASE: {
    head(key: string): Promise<ShowcaseBucketObject | null>;
    get(key: string, options?: { onlyIf?: Headers; range?: Headers }): Promise<ShowcaseBucketObject | null>;
  };
}

export function serveShowcase(
  request: Request,
  env: ShowcaseEnvironment,
  fetchBackend?: (request: Request) => Promise<Response>,
): Promise<Response>;
declare const worker: { fetch(request: Request, env: ShowcaseEnvironment): Promise<Response> };
export default worker;
