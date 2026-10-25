// SPDX-License-Identifier: MIT
/**
 * Long-running Crunchyroll metadata service: a sync loop (crawler), a catalog index, the metadata API and a resolver.
 *
 * It only moves public metadata: official series and watch references the caller supplies (or that a configured client
 * returns) are registered in the video catalog, and the HTTP layer answers from that catalog. It performs no sign-in,
 * cookie handling, DRM or playback. Upstream access is whatever `clientFactory` the deployment injects.
 */
import { timingSafeEqual } from "node:crypto";
import { parseCrunchyrollSeriesUrl, parseCrunchyrollWatchUrl } from "./crunchyroll";
import { createCrunchyrollApi, type CrunchyrollApiOptions } from "./crunchyroll-api";
import {
  importCrunchyrollWatchlist,
  registerObservedCrunchyrollWatchlist,
  type CrunchyrollWatchlistClient,
  type CrunchyrollWatchlistEntry,
} from "./crunchyroll-watchlist";
import type { VideoCatalog, VideoSource } from "./video-catalog";
import type { NeonVideoCatalog } from "./video-neon-catalog";

export type SyncOutcome = "ok" | "failed" | "skipped";

export interface SyncState {
  runs: number;
  consecutiveFailures: number;
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: SyncOutcome | null;
  /** Stable code only: no upstream body, URL or credential is retained. */
  lastError: string | null;
  lastCounts: { references: number; added: number; existing: number; episodes: number } | null;
  nextRunAt: string | null;
}

export interface ShenronMapping {
  /** Shenron database wiki episode ID; never an episode number or a Crunchyroll ID. */
  episodeId: number;
}

export interface CrunchyrollServiceOptions {
  catalog: VideoCatalog | NeonVideoCatalog;
  /** Supplies the observed references for one cycle (a drop file, a database query, an authenticated page capture). */
  loadEntries: (signal: AbortSignal) => Promise<readonly CrunchyrollWatchlistEntry[]>;
  /** When set, series are expanded to seasons and episodes through this client; otherwise references are registered as observed. */
  clientFactory?: (signal: AbortSignal) => CrunchyrollWatchlistClient | Promise<CrunchyrollWatchlistClient>;
  /** Maps an official content ID to a Shenron episode; absent means "no mapping known". */
  shenron?: (contentId: string) => ShenronMapping | null | Promise<ShenronMapping | null>;
  apiToken?: string;
  /** Private metadata routes of the underlying API (anime, seasons, episodes, search). */
  api?: Pick<CrunchyrollApiOptions, "clientFactory" | "timeoutMs">;
  intervalMs?: number;
  /** Cap of the failure backoff; the delay doubles from `intervalMs`. */
  maxBackoffMs?: number;
  cycleTimeoutMs?: number;
  now?: () => number;
  /** Replaceable for tests: schedules the next cycle and returns its canceller. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "cycle_timeout";
  if (error instanceof RangeError) return "bounds_exceeded";
  if (error instanceof TypeError) return "invalid_input";
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number")
    return `upstream_${error.status}`;
  return "sync_failed";
}

function bearerMatches(request: Request, token: string): boolean {
  const value = request.headers.get("authorization");
  const bearer = value && /^Bearer (\S+)$/i.exec(value)?.[1];
  if (!bearer || bearer.length > 4096) return false;
  const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest();
  return timingSafeEqual(digest(bearer), digest(token));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export function parseContentReference(input: string): { kind: "series" | "watch"; contentId: string; url: string } {
  const text = input.trim();
  if (/^[A-Z0-9]{9,32}$/.test(text)) return { kind: "watch", contentId: text, url: "" };
  try {
    const watch = parseCrunchyrollWatchUrl(text);
    return { kind: "watch", contentId: watch.contentId, url: `https://www.crunchyroll.com/watch/${watch.contentId}` };
  } catch {
    const series = parseCrunchyrollSeriesUrl(text);
    return {
      kind: "series",
      contentId: series.contentId,
      url: `https://www.crunchyroll.com/series/${series.contentId}`,
    };
  }
}

export function createCrunchyrollService(options: CrunchyrollServiceOptions) {
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const maxBackoffMs = options.maxBackoffMs ?? 6 * 60 * 60_000;
  const cycleTimeoutMs = options.cycleTimeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 24 * 3_600_000)
    throw new RangeError("intervalMs must be 1000..86400000");
  if (!Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs) throw new RangeError("invalid maxBackoffMs");
  if (!Number.isSafeInteger(cycleTimeoutMs) || cycleTimeoutMs < 1 || cycleTimeoutMs > 3_600_000)
    throw new RangeError("cycleTimeoutMs must be 1..3600000");
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const state: SyncState = {
    runs: 0,
    consecutiveFailures: 0,
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    lastError: null,
    lastCounts: null,
    nextRunAt: null,
  };
  let cancel: (() => void) | undefined;
  let stopped = true;
  let inflight: Promise<SyncState> | undefined;
  const iso = (time: number) => new Date(time).toISOString();

  async function cycle(): Promise<SyncState> {
    if (state.running) {
      state.lastOutcome = "skipped";
      return { ...state };
    }
    state.running = true;
    state.runs++;
    state.lastStartedAt = iso(now());
    const signal = AbortSignal.timeout(cycleTimeoutMs);
    try {
      const entries = await options.loadEntries(signal);
      signal.throwIfAborted();
      if (options.clientFactory) {
        const result = await importCrunchyrollWatchlist(options.catalog, entries, {
          clientFactory: options.clientFactory,
          signal,
          timeoutMs: cycleTimeoutMs,
        });
        state.lastCounts = {
          references: result.series + result.pendingVideos.length,
          added: result.addedSources,
          existing: result.existingSources,
          episodes: result.episodes.length,
        };
      } else {
        const result = await registerObservedCrunchyrollWatchlist(options.catalog, entries);
        state.lastCounts = {
          references: result.references.length,
          added: result.addedSources,
          existing: result.existingSources,
          episodes: 0,
        };
      }
      state.consecutiveFailures = 0;
      state.lastOutcome = "ok";
      state.lastError = null;
      state.lastSuccessAt = iso(now());
    } catch (error) {
      state.consecutiveFailures++;
      state.lastOutcome = "failed";
      state.lastError = errorCode(error);
    } finally {
      state.running = false;
      state.lastFinishedAt = iso(now());
    }
    return { ...state };
  }

  function next() {
    if (stopped) return;
    const delay =
      state.consecutiveFailures === 0
        ? intervalMs
        : Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(state.consecutiveFailures, 20));
    state.nextRunAt = iso(now() + delay);
    cancel = schedule(() => {
      inflight = cycle().finally(next);
    }, delay);
  }

  const api = createCrunchyrollApi({ apiToken: options.apiToken, ...options.api });

  async function listCrunchyrollSources(): Promise<VideoSource[]> {
    const rows = await options.catalog.listSources();
    return rows.filter(source => source.providerId === "crunchyroll");
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/health") {
      const stale =
        state.lastSuccessAt === null
          ? state.runs > 0
          : now() - Date.parse(state.lastSuccessAt) > Math.max(3 * intervalMs, maxBackoffMs);
      return json(
        {
          status: stale || state.lastOutcome === "failed" ? "degraded" : "ok",
          intervalMs,
          sync: state,
          privateApiConfigured: Boolean(options.apiToken),
          metadataClientConfigured: Boolean(options.clientFactory),
          shenronResolverConfigured: Boolean(options.shenron),
          playback: "browser-provider-required",
        },
        stale ? 503 : 200,
      );
    }
    if (url.pathname === "/v1/index/sources") {
      if (!options.apiToken) return json({ error: "authentication_required" }, 401);
      if (!bearerMatches(request, options.apiToken)) return json({ error: "authentication_required" }, 401);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const kind = url.searchParams.get("kind");
      const rows = (await listCrunchyrollSources()).filter(source =>
        kind === "series" || kind === "video" ? source.id.startsWith(`crunchyroll:${kind}:`) : true,
      );
      return json({
        total: rows.length,
        sources: rows.slice(0, limit).map(source => ({ id: source.id, url: source.url, title: source.title })),
      });
    }
    if (url.pathname === "/v1/resolve") {
      const value = url.searchParams.get("url") ?? url.searchParams.get("id");
      if (!value || value.length > 2048) return json({ error: "invalid_reference" }, 400);
      let reference: ReturnType<typeof parseContentReference>;
      try {
        reference = parseContentReference(value);
      } catch {
        return json({ error: "invalid_reference" }, 400);
      }
      const rows = await listCrunchyrollSources();
      const match =
        rows.find(
          source =>
            source.id === `crunchyroll:${reference.kind === "series" ? "series" : "video"}:${reference.contentId}`,
        ) ?? (reference.url ? undefined : rows.find(source => source.id.endsWith(`:${reference.contentId}`)));
      const kind = match ? (match.id.startsWith("crunchyroll:series:") ? "series" : "watch") : reference.kind;
      const canonical = match?.url ?? (reference.url || null);
      const mapping = options.shenron ? await options.shenron(reference.contentId) : null;
      return json({
        contentId: reference.contentId,
        kind,
        url: canonical,
        catalog: match ? { sourceId: match.id, title: match.title } : null,
        shenron: mapping,
        playback: "browser-provider-required",
      });
    }
    return api(request);
  }

  return {
    state: () => ({ ...state }),
    /** Runs one cycle now; overlapping calls return the current state with outcome "skipped". */
    syncOnce: cycle,
    start() {
      if (!stopped) return;
      stopped = false;
      inflight = cycle().finally(next);
    },
    async stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
      state.nextRunAt = null;
      await inflight?.catch(() => {});
    },
    fetch: handle,
  };
}
