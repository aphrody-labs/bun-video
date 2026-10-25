// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto";
import {
  CrunchyrollError,
  createCrunchyrollClient,
  parseCrunchyrollWatchUrl,
  type CrunchyrollClient,
  type CrunchyrollOptions,
} from "./crunchyroll";

export type CrunchyrollMetadataClient = Pick<CrunchyrollClient, "getAnime" | "getSeasons" | "getEpisodes" | "search">;
export interface CrunchyrollApiOptions {
  readonly apiToken?: string;
  readonly timeoutMs?: number;
  readonly clientFactory?: (signal: AbortSignal) => CrunchyrollMetadataClient | Promise<CrunchyrollMetadataClient>;
}

export function crunchyrollClientFactory(
  options: CrunchyrollOptions,
): NonNullable<CrunchyrollApiOptions["clientFactory"]> {
  return async signal => {
    const client = createCrunchyrollClient({ ...options, signal });
    const login = await client.loginWithAccessToken();
    if (!login.success) throw new CrunchyrollError("Configured upstream authentication failed", 401);
    return client;
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(status === 405 ? { allow: "GET" } : {}),
    },
  });
}

function authorized(request: Request, token: string): boolean {
  const value = request.headers.get("authorization");
  const bearer = value && /^Bearer (\S+)$/i.exec(value)?.[1];
  if (!bearer || bearer.length > 4096) return false;
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();
  return timingSafeEqual(digest(bearer), digest(token));
}

export async function awaitCrunchyrollOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Stateless metadata-only handler. Credentials remain in its explicitly configured factory. */
export function createCrunchyrollApi(options: CrunchyrollApiOptions = {}): (request: Request) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new RangeError("API timeout must be 1..120000 milliseconds");
  if (
    options.apiToken !== undefined &&
    (typeof options.apiToken !== "string" || !options.apiToken || options.apiToken.length > 4096)
  )
    throw new TypeError("API token must be nonempty and at most 4096 characters");
  return async request => {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/health")
      return json({
        status: "ok",
        privateApiConfigured: Boolean(options.apiToken),
        metadataClientConfigured: Boolean(options.clientFactory),
        playback: "browser-provider-required",
      });
    if (url.pathname === "/v1/watch") {
      const value = url.searchParams.get("url");
      if (!value || value.length > 2048) return json({ error: "invalid_watch_url" }, 400);
      try {
        const parsed = parseCrunchyrollWatchUrl(value);
        const canonical = new URL(parsed.url);
        canonical.search = "";
        canonical.hash = "";
        return json({
          ...parsed,
          url: canonical.href,
          metadata: "requires-configured-client",
          playback: "browser-provider-required",
        });
      } catch {
        return json({ error: "invalid_watch_url" }, 400);
      }
    }
    const resource = /^\/v1\/(anime|seasons)\/([A-Z0-9]{9,32})(?:\/(seasons|episodes))?$/.exec(url.pathname);
    const search = url.pathname === "/v1/search";
    if (!resource && !search) return json({ error: "not_found" }, 404);
    if (!options.apiToken || !authorized(request, options.apiToken))
      return json({ error: "authentication_required" }, 401);
    if (!options.clientFactory) return json({ error: "metadata_client_unavailable" }, 503);
    const query = search ? url.searchParams.get("q")?.trim() : undefined;
    if (search && (!query || query.length > 256)) return json({ error: "invalid_search_query" }, 400);
    if (
      resource &&
      !(
        (resource[1] === "anime" && (!resource[3] || resource[3] === "seasons")) ||
        (resource[1] === "seasons" && resource[3] === "episodes")
      )
    )
      return json({ error: "not_found" }, 404);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      signal.throwIfAborted();
      const client = await awaitCrunchyrollOperation(Promise.resolve(options.clientFactory(signal)), signal);
      signal.throwIfAborted();
      const operation = search
        ? client.search(query!)
        : resource![1] === "seasons"
          ? client.getEpisodes(resource![2]!)
          : resource![3] === "seasons"
            ? client.getSeasons(resource![2]!)
            : client.getAnime(resource![2]!);
      return json(await awaitCrunchyrollOperation(operation, signal));
    } catch (error) {
      if (deadline.aborted) return json({ error: "upstream_timeout" }, 504);
      if (request.signal.aborted) return json({ error: "request_aborted" }, 408);
      return json(
        {
          error: "upstream_failed",
          ...(error instanceof CrunchyrollError && error.status ? { upstreamStatus: error.status } : {}),
        },
        502,
      );
    }
  };
}
