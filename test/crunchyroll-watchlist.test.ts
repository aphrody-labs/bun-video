import { expect, test } from "bun:test";
import { CrunchyrollError, parseCrunchyrollSeriesUrl } from "../src/crunchyroll";
import {
  importCrunchyrollWatchlist,
  registerObservedCrunchyrollWatchlist,
  type CrunchyrollWatchlistClient,
} from "../src/crunchyroll-watchlist";
import { VideoCatalog } from "../src/video-catalog";
import { parseCrunchyrollCli } from "../src/crunchyroll-cli";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seriesId = "G6QWZXWDY";
const seasonId = "GR0012345";
const episodeIds = ["GE0012345", "GE0012346"];
const entries = [{ url: `https://www.crunchyroll.com/fr/series/${seriesId}/fixture?private=never-exported` }];

function provider(
  options: { incomplete?: boolean; otherSeason?: boolean; fail?: boolean } = {},
): CrunchyrollWatchlistClient {
  return {
    async getAnime(id) {
      return { id, title: "Fixture 悟空", access_token: "never-stored" };
    },
    async getSeasons(id) {
      return { total: 1, items: [{ id: seasonId, series_id: id }] };
    },
    async getEpisodes(id) {
      if (options.fail) throw new CrunchyrollError("API request failed (401)", 401);
      return {
        total: options.incomplete ? 3 : 2,
        items: episodeIds.map(episodeId => ({
          id: episodeId,
          title: `Fixture ${episodeId}`,
          series_id: seriesId,
          season_id: options.otherSeason ? "GR9999999" : id,
          signature: "never-stored",
        })),
      };
    },
  };
}

test("official series parsing shares the watch URL origin boundary", () => {
  expect(parseCrunchyrollSeriesUrl(entries[0]!.url)).toMatchObject({ contentId: seriesId, locale: "fr" });
  for (const url of [
    `https://evil.test/series/${seriesId}`,
    `https://user:password@www.crunchyroll.com/series/${seriesId}`,
    `http://www.crunchyroll.com/series/${seriesId}`,
    `https://www.crunchyroll.com/watch/${seriesId}`,
  ])
    expect(() => parseCrunchyrollSeriesUrl(url)).toThrow();
});

test("observed series expand through the existing client and import once into its catalog", async () => {
  using catalog = new VideoCatalog(":memory:");
  const input = [...entries, { url: `https://www.crunchyroll.com/series/${seriesId}` }];
  const result = await importCrunchyrollWatchlist(catalog, input, { clientFactory: () => provider() });
  expect(result).toMatchObject({
    series: 1,
    seasons: 1,
    addedSources: 3,
    existingSources: 0,
    scope: "supplied-watchlist-series",
  });
  expect(result.episodes.map(row => row.id)).toEqual(episodeIds);
  expect(
    catalog
      .listSources()
      .map(row => row.url)
      .sort(),
  ).toEqual(
    [
      `https://www.crunchyroll.com/watch/${episodeIds[0]}`,
      `https://www.crunchyroll.com/watch/${episodeIds[1]}`,
      `https://www.crunchyroll.com/series/${seriesId}`,
    ].sort(),
  );
  const second = await importCrunchyrollWatchlist(catalog, entries, { clientFactory: () => provider() });
  expect(second).toMatchObject({ addedSources: 0, existingSources: 3 });
  expect(catalog.listSources()).toHaveLength(3);
  expect(JSON.stringify(catalog.listSources())).not.toContain("never-");
  expect(catalog.listJobs()).toEqual([]);
});

test("metadata refresh preserves existing private media references and jobs", async () => {
  using catalog = new VideoCatalog(":memory:");
  const source = catalog.registerSource({
    id: `crunchyroll:episode:${episodeIds[0]}`,
    privateRef: "C:/protected/episode.mp4",
  });
  const job = catalog.addJob({ sourceId: source.id, engine: "native" });
  const result = await importCrunchyrollWatchlist(catalog, entries, { clientFactory: () => provider() });
  expect(result).toMatchObject({ addedSources: 2, existingSources: 1 });
  expect(catalog.listSources().find(row => row.id === source.id)).toEqual(source);
  expect(catalog.getJob(job.id)).toMatchObject(job);
});

test("partial, unrelated, oversized and failed metadata never produce a partial import", async () => {
  for (const options of [{ incomplete: true }, { otherSeason: true }, { fail: true }]) {
    using catalog = new VideoCatalog(":memory:");
    await expect(
      importCrunchyrollWatchlist(catalog, entries, { clientFactory: () => provider(options) }),
    ).rejects.toThrow();
    expect(catalog.listSources()).toEqual([]);
    expect(catalog.listProviders()).toEqual([]);
  }
  using catalog = new VideoCatalog(":memory:");
  await expect(
    importCrunchyrollWatchlist(catalog, entries, { clientFactory: () => provider(), maxEpisodes: 1 }),
  ).rejects.toThrow("bounds");
  expect(catalog.listSources()).toEqual([]);
});

test("cancellation is checked before a configured provider is called", async () => {
  using catalog = new VideoCatalog(":memory:");
  let called = false;
  await expect(
    importCrunchyrollWatchlist(catalog, entries, {
      signal: AbortSignal.abort(new Error("cancelled")),
      clientFactory: () => {
        called = true;
        return provider();
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(called).toBe(false);
});

test("observed series and movies register without an upstream client, secrets or duplicate identities", () => {
  using catalog = new VideoCatalog(":memory:");
  const movie = {
    url: "https://www.crunchyroll.com/fr/watch/G6W4Z0EGR/movie?token=discarded#private",
    title: "Film 悟空",
  };
  const result = registerObservedCrunchyrollWatchlist(catalog, [...entries, movie, movie]);
  expect(result).toMatchObject({
    addedSources: 2,
    existingSources: 0,
    scope: "supplied-observed-references",
    expansion: "pending",
  });
  expect(result.references).toEqual([
    {
      kind: "series",
      contentId: seriesId,
      sourceId: `crunchyroll:series:${seriesId}`,
      url: `https://www.crunchyroll.com/series/${seriesId}`,
      title: null,
    },
    {
      kind: "watch",
      contentId: "G6W4Z0EGR",
      sourceId: "crunchyroll:video:G6W4Z0EGR",
      url: "https://www.crunchyroll.com/watch/G6W4Z0EGR",
      title: "Film 悟空",
    },
  ]);
  expect(registerObservedCrunchyrollWatchlist(catalog, [movie, ...entries])).toMatchObject({
    addedSources: 0,
    existingSources: 2,
  });
  expect(
    catalog
      .listSources()
      .every(source => source.privateRef === null && !new URL(source.url!).search && !new URL(source.url!).hash),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain("token");
  expect(catalog.listJobs()).toEqual([]);
  expect(catalog.listProviders()[0]!.status).toBe("not_tested");
});

test("observed metadata preserves historical movie/episode references, provider qualification and jobs", () => {
  using catalog = new VideoCatalog(":memory:");
  catalog.registerProvider({
    id: "crunchyroll",
    name: "Crunchyroll",
    family: "video",
    status: "passed",
    sourceRef: "private-provider-ref",
  });
  const source = catalog.registerSource({ id: "crunchyroll:movie:G6W4Z0EGR", privateRef: "C:/protected/movie.mp4" });
  const job = catalog.addJob({ sourceId: source.id, engine: "native" });
  const result = registerObservedCrunchyrollWatchlist(catalog, [
    { url: "https://www.crunchyroll.com/watch/G6W4Z0EGR" },
  ]);
  expect(result).toMatchObject({ addedSources: 0, existingSources: 1 });
  expect(result.references[0]!.sourceId).toBe(source.id);
  expect(catalog.listSources()).toEqual([source]);
  expect(catalog.getJob(job.id)).toEqual(job);
  expect(catalog.listProviders()[0]).toMatchObject({ status: "passed", sourceRef: "private-provider-ref" });
});

test("invalid observed entries never partially modify the catalog", () => {
  for (const entry of [
    { url: "https://evil.test/watch/G6W4Z0EGR" },
    { url: "https://www.crunchyroll.com/watch/G6W4Z0EGR", title: "bad\nvalue" },
    { url: "https://www.crunchyroll.com/series/missing" },
  ]) {
    using catalog = new VideoCatalog(":memory:");
    expect(() => registerObservedCrunchyrollWatchlist(catalog, [...entries, entry])).toThrow();
    expect(catalog.listSources()).toEqual([]);
    expect(catalog.listProviders()).toEqual([]);
  }
});

test("movie observations remain pending during real-client series expansion", async () => {
  using catalog = new VideoCatalog(":memory:");
  const movie = { url: "https://www.crunchyroll.com/watch/G6W4Z0EGR", title: "Observed movie" };
  const result = await importCrunchyrollWatchlist(catalog, [...entries, movie], { clientFactory: () => provider() });
  expect(result).toMatchObject({ series: 1, seasons: 1, addedSources: 4 });
  expect(result.pendingVideos).toHaveLength(1);
  expect(result.pendingVideos[0]).toMatchObject({ kind: "watch", contentId: "G6W4Z0EGR" });
  expect(catalog.listSources()).toHaveLength(4);
  const watchOnly = await importCrunchyrollWatchlist(catalog, [movie], {
    clientFactory() {
      throw new Error("Watch references have no implemented metadata lookup operation");
    },
  });
  expect(watchOnly).toMatchObject({ series: 0, seasons: 0, episodes: [], addedSources: 0, existingSources: 1 });
});

test("observation and later expansion share the same watch content identity", async () => {
  using catalog = new VideoCatalog(":memory:");
  const watch = { url: `https://www.crunchyroll.com/watch/${episodeIds[0]}` };
  registerObservedCrunchyrollWatchlist(catalog, [watch]);
  const result = await importCrunchyrollWatchlist(catalog, [...entries, watch], { clientFactory: () => provider() });
  expect(result).toMatchObject({ addedSources: 2, existingSources: 1 });
  expect(result.episodes[0]!.sourceId).toBe(result.pendingVideos[0]!.sourceId);
  expect(catalog.listSources()).toHaveLength(3);
});

test("watchlist CLI accepts only bounded metadata/import configuration, never token arguments", () => {
  expect(parseCrunchyrollCli(["watchlist", "metadata", "observed.json"])).toEqual({
    command: "watchlist",
    operation: "metadata",
    inputPath: "observed.json",
    catalogPath: undefined,
    timeoutMs: 300000,
  });
  expect(
    parseCrunchyrollCli(["watchlist", "import", "observed.json", "--catalog", "catalog.sqlite", "--timeout", "1000"]),
  ).toMatchObject({
    operation: "import",
    catalogPath: "catalog.sqlite",
    timeoutMs: 1000,
  });
  for (const args of [
    ["watchlist", "import"],
    ["watchlist", "sync", "observed.json"],
    ["watchlist", "metadata", "observed.json", "--token", "private"],
    ["watchlist", "import", "observed.json", "--timeout", "0"],
    ["watchlist", "import", "observed.json", "--timeout", "300001"],
    ["watchlist", "import", "observed.json", "--catalog", "one", "--catalog", "two"],
  ])
    expect(() => parseCrunchyrollCli(args)).toThrow();
});

test("metadata CLI persists observed movie references without authentication or media jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-video-watchlist-"));
  try {
    const input = join(directory, "observed.json"),
      path = join(directory, "catalog.sqlite");
    await Bun.write(
      input,
      JSON.stringify([
        ...entries,
        {
          url: "https://www.crunchyroll.com/watch/G6W4Z0EGR/movie?token=discarded",
          title: "Observed movie",
        },
      ]),
    );
    await using child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/crunchyroll-cli.ts"),
        "watchlist",
        "metadata",
        input,
        "--catalog",
        path,
      ],
      {
        env: {
          ...process.env,
          BUN_BE_BUN: "1",
          BUN_DEBUG_QUIET_LOGS: "1",
          // Isolate the cutover marker of the operator's production catalog from this fixture.
          APHRODY_HOME: directory,
          BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN: undefined,
          BUN_VIDEO_CRUNCHYROLL_API_TOKEN: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [output, error, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(error).toBe("");
    expect(JSON.parse(output)).toMatchObject({
      addedSources: 2,
      scope: "supplied-observed-references",
      expansion: "pending",
    });
    expect(output).not.toContain("token");
    expect(code).toBe(0);
    using catalog = new VideoCatalog(path);
    expect(catalog.listSources()).toHaveLength(2);
    expect(catalog.listJobs()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
