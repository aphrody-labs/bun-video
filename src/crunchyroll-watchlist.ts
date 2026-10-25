import {
  CrunchyrollError,
  parseCrunchyrollSeriesUrl,
  parseCrunchyrollWatchUrl,
  type CrunchyrollClient,
} from "./crunchyroll";
import { awaitCrunchyrollOperation } from "./crunchyroll-api";
import { frameOperationSignal } from "./frame-plan";
import { VideoCatalog, type VideoSource } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";

export interface CrunchyrollWatchlistEntry {
  /** Official series or watch URL observed in the owner's authenticated watchlist. */
  url: string;
  title?: string;
}

export interface ObservedCrunchyrollReference {
  kind: "series" | "watch";
  contentId: string;
  sourceId: string;
  url: string;
  title: string | null;
}

export interface ObservedCrunchyrollWatchlist {
  references: ObservedCrunchyrollReference[];
  addedSources: number;
  existingSources: number;
  scope: "supplied-observed-references";
  expansion: "pending";
}

export interface CrunchyrollWatchlistEpisode {
  id: string;
  sourceId: string;
  seriesId: string;
  seasonId: string;
  title: string | null;
  url: string;
}

export interface CrunchyrollWatchlistImport {
  series: number;
  seasons: number;
  episodes: CrunchyrollWatchlistEpisode[];
  addedSources: number;
  existingSources: number;
  /** Watch references (including movies) retained without inventing an episode lookup API. */
  pendingVideos: ObservedCrunchyrollReference[];
  /** Completeness of the supplied observed entries, not of an unobserved account. */
  scope: "supplied-watchlist-series";
}

export type CrunchyrollWatchlistClient = Pick<CrunchyrollClient, "getAnime" | "getSeasons" | "getEpisodes">;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CrunchyrollError("Metadata response must be an object");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9]{9,32}$/.test(value))
    throw new CrunchyrollError("Metadata has an invalid content identifier");
  return value;
}

function title(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new CrunchyrollError("Metadata has an invalid title");
  return value.trim() || null;
}

function completeItems(value: unknown): Record<string, unknown>[] {
  const response = object(value);
  if (
    !Array.isArray(response.items) ||
    !Number.isSafeInteger(response.total) ||
    response.total !== response.items.length
  )
    throw new CrunchyrollError("Metadata list is incomplete; verified provider pagination is required");
  return response.items.map(object);
}

function observedReferences(entries: readonly CrunchyrollWatchlistEntry[]): ObservedCrunchyrollReference[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10000)
    throw new RangeError("Import 1..10000 observed watchlist entries");
  const references = new Map<string, ObservedCrunchyrollReference>();
  for (const entry of entries) {
    if (!entry || typeof entry.url !== "string" || entry.url.length > 2048)
      throw new CrunchyrollError("Watchlist entries require bounded official series or watch URLs");
    let parsed, kind: "series" | "watch";
    try {
      parsed = parseCrunchyrollSeriesUrl(entry.url);
      kind = "series";
    } catch {
      parsed = parseCrunchyrollWatchUrl(entry.url);
      kind = "watch";
    }
    const sourceId = `crunchyroll:${kind === "series" ? "series" : "video"}:${parsed.contentId}`;
    const value = title(entry.title);
    if (!references.has(sourceId))
      references.set(sourceId, {
        kind,
        contentId: parsed.contentId,
        sourceId,
        url: `https://www.crunchyroll.com/${kind}/${parsed.contentId}`,
        title: value,
      });
  }
  return [...references.values()];
}

interface SourceCandidate {
  id: string;
  url: string;
  title: string | null;
}

/** Resolve historical source identities before inserting new observations. */
function planSources(existing: readonly VideoSource[], candidates: readonly SourceCandidate[]) {
  let addedSources = 0,
    existingSources = 0;
  const sourceIds = new Map<string, string>();
  const insert: SourceCandidate[] = [];
  const byId = new Map(existing.map(source => [source.id, source]));
  const byReference = new Map<string, (typeof existing)[number]>();
  for (const source of existing) {
    if (!source.url || source.providerId !== "crunchyroll") continue;
    try {
      const reference = observedReferences([{ url: source.url }])[0]!;
      if (!byReference.has(reference.sourceId)) byReference.set(reference.sourceId, source);
    } catch {
      /* Other provider-owned source URLs are outside the observed reference contract. */
    }
  }
  for (const candidate of new Map(candidates.map(source => [source.id, source])).values()) {
    const contentId = candidate.id.split(":").at(-1)!;
    const prior =
      byId.get(candidate.id) ??
      (candidate.id.startsWith("crunchyroll:video:")
        ? (byId.get(`crunchyroll:episode:${contentId}`) ?? byId.get(`crunchyroll:movie:${contentId}`))
        : undefined) ??
      byReference.get(candidate.id);
    if (prior) {
      sourceIds.set(candidate.id, prior.id);
      existingSources++;
      continue;
    }
    const source: VideoSource = {
      id: candidate.id,
      url: candidate.url,
      privateRef: null,
      providerId: "crunchyroll",
      kind: "url",
      title: candidate.title,
    };
    insert.push(candidate);
    byId.set(source.id, source);
    byReference.set(candidate.id, source);
    sourceIds.set(candidate.id, source.id);
    addedSources++;
  }
  return { addedSources, existingSources, sourceIds, insert };
}

/** One insertion owner: existing source identities, private references and jobs stay intact. */
function registerSources(catalog: VideoCatalog, candidates: readonly SourceCandidate[]) {
  return catalog.db.transaction(() => {
    if (!catalog.listProviders().some(provider => provider.id === "crunchyroll"))
      catalog.registerProvider({ id: "crunchyroll", name: "Crunchyroll", family: "video" });
    const plan = planSources(catalog.listSources(), candidates);
    for (const candidate of plan.insert)
      catalog.registerSource({
        id: candidate.id,
        url: candidate.url,
        ...(candidate.title ? { title: candidate.title } : {}),
        providerId: "crunchyroll",
        kind: "url",
      });
    return plan;
  })();
}

async function registerSourcesNeon(catalog: NeonVideoCatalog, candidates: readonly SourceCandidate[]) {
  return catalog.transaction(async tx => {
    if (!(await tx.listProviders()).some(provider => provider.id === "crunchyroll"))
      await tx.registerProvider({ id: "crunchyroll", name: "Crunchyroll", family: "video" });
    const plan = planSources(await tx.listSources(), candidates);
    for (const candidate of plan.insert)
      await tx.registerSource({
        id: candidate.id,
        url: candidate.url,
        ...(candidate.title ? { title: candidate.title } : {}),
        providerId: "crunchyroll",
        kind: "url",
      });
    return plan;
  });
}

/** Registers supplied observations only; performs no network, authentication or playback operation. */
export function registerObservedCrunchyrollWatchlist(
  catalog: VideoCatalog,
  entries: readonly CrunchyrollWatchlistEntry[],
): ObservedCrunchyrollWatchlist;
export function registerObservedCrunchyrollWatchlist(
  catalog: NeonVideoCatalog,
  entries: readonly CrunchyrollWatchlistEntry[],
): Promise<ObservedCrunchyrollWatchlist>;
export function registerObservedCrunchyrollWatchlist(
  catalog: VideoCatalog | NeonVideoCatalog,
  entries: readonly CrunchyrollWatchlistEntry[],
): ObservedCrunchyrollWatchlist | Promise<ObservedCrunchyrollWatchlist>;
export function registerObservedCrunchyrollWatchlist(
  catalog: VideoCatalog | NeonVideoCatalog,
  entries: readonly CrunchyrollWatchlistEntry[],
): ObservedCrunchyrollWatchlist | Promise<ObservedCrunchyrollWatchlist> {
  const references = observedReferences(entries);
  const candidates = references.map(reference => ({
    id: reference.sourceId,
    url: reference.url,
    title: reference.title,
  }));
  const format = (result: ReturnType<typeof planSources>): ObservedCrunchyrollWatchlist => ({
    references: references.map(reference => ({ ...reference, sourceId: result.sourceIds.get(reference.sourceId)! })),
    addedSources: result.addedSources,
    existingSources: result.existingSources,
    scope: "supplied-observed-references",
    expansion: "pending",
  });
  return catalog instanceof NeonVideoCatalog
    ? registerSourcesNeon(catalog, candidates).then(format)
    : format(registerSources(catalog, candidates));
}

/** Imports metadata through the existing client; observation and playback remain owned by their providers. */
export async function importCrunchyrollWatchlist(
  catalog: VideoCatalog | NeonVideoCatalog,
  entries: readonly CrunchyrollWatchlistEntry[],
  options: {
    clientFactory: (signal: AbortSignal) => CrunchyrollWatchlistClient | Promise<CrunchyrollWatchlistClient>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxSeasons?: number;
    maxEpisodes?: number;
  },
): Promise<CrunchyrollWatchlistImport> {
  const references = observedReferences(entries);
  const maxSeasons = options.maxSeasons ?? 20000;
  const maxEpisodes = options.maxEpisodes ?? 100000;
  if (
    !Number.isSafeInteger(maxSeasons) ||
    maxSeasons < 1 ||
    maxSeasons > 20000 ||
    !Number.isSafeInteger(maxEpisodes) ||
    maxEpisodes < 1 ||
    maxEpisodes > 100000
  )
    throw new RangeError("Invalid bounded watchlist metadata limits");
  const seriesIds = new Set(
    references.filter(reference => reference.kind === "series").map(reference => reference.contentId),
  );
  const signal = frameOperationSignal(options.timeoutMs ?? 300000, options.signal);
  signal.throwIfAborted();
  const client = seriesIds.size
    ? await awaitCrunchyrollOperation(Promise.resolve(options.clientFactory(signal)), signal)
    : undefined;
  const sources: SourceCandidate[] = references
    .filter(reference => reference.kind === "watch")
    .map(reference => ({
      id: reference.sourceId,
      url: reference.url,
      title: reference.title,
    }));
  const episodes = new Map<string, CrunchyrollWatchlistEpisode>();
  const seasons = new Set<string>();
  for (const seriesId of seriesIds) {
    signal.throwIfAborted();
    const anime = object(await awaitCrunchyrollOperation(client!.getAnime(seriesId), signal));
    if (id(anime.id) !== seriesId)
      throw new CrunchyrollError("Series metadata does not match the observed watchlist entry");
    sources.push({
      id: `crunchyroll:series:${seriesId}`,
      url: `https://www.crunchyroll.com/series/${seriesId}`,
      title: title(anime.title),
    });
    const rows = completeItems(await awaitCrunchyrollOperation(client!.getSeasons(seriesId), signal));
    if (seasons.size + rows.length > maxSeasons) throw new RangeError("Watchlist exceeds season metadata bounds");
    for (const row of rows) {
      signal.throwIfAborted();
      const seasonId = id(row.id);
      if (row.series_id !== undefined && row.series_id !== seriesId)
        throw new CrunchyrollError("Season metadata belongs to another series");
      if (seasons.has(seasonId)) throw new CrunchyrollError("Duplicate season in watchlist metadata");
      seasons.add(seasonId);
      const items = completeItems(await awaitCrunchyrollOperation(client!.getEpisodes(seasonId), signal));
      if (episodes.size + items.length > maxEpisodes) throw new RangeError("Watchlist exceeds episode metadata bounds");
      for (const item of items) {
        const episodeId = id(item.id);
        if (
          (item.series_id !== undefined && item.series_id !== seriesId) ||
          (item.season_id !== undefined && item.season_id !== seasonId)
        )
          throw new CrunchyrollError("Episode metadata belongs to another season or series");
        if (episodes.has(episodeId)) throw new CrunchyrollError("Duplicate episode in watchlist metadata");
        episodes.set(episodeId, {
          id: episodeId,
          sourceId: `crunchyroll:video:${episodeId}`,
          seriesId,
          seasonId,
          title: title(item.title),
          url: `https://www.crunchyroll.com/watch/${episodeId}`,
        });
      }
    }
  }
  signal.throwIfAborted();
  const candidates = [
    ...sources,
    ...[...episodes.values()].map(episode => ({
      id: episode.sourceId,
      url: episode.url,
      title: episode.title,
    })),
  ];
  const result =
    catalog instanceof NeonVideoCatalog
      ? await registerSourcesNeon(catalog, candidates)
      : registerSources(catalog, candidates);
  return {
    series: seriesIds.size,
    seasons: seasons.size,
    episodes: [...episodes.values()].map(episode => ({
      ...episode,
      sourceId: result.sourceIds.get(episode.sourceId)!,
    })),
    addedSources: result.addedSources,
    existingSources: result.existingSources,
    pendingVideos: references
      .filter(reference => reference.kind === "watch")
      .map(reference => ({
        ...reference,
        sourceId: result.sourceIds.get(reference.sourceId)!,
      })),
    scope: "supplied-watchlist-series",
  };
}
