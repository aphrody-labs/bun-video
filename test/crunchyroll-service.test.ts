import { describe, expect, test } from "bun:test";
import { createCrunchyrollService } from "../src/crunchyroll-service";
import { VideoCatalog } from "../src/video-catalog";

const SERIES = "GRDV0019R";
const WATCH = "GY8VM8MWY";

function fixture(overrides: Partial<Parameters<typeof createCrunchyrollService>[0]> = {}) {
  const catalog = new VideoCatalog(":memory:");
  const scheduled: { run: () => void; delay: number; cancelled: boolean }[] = [];
  let clock = Date.parse("2026-10-18T12:00:00Z");
  const service = createCrunchyrollService({
    catalog,
    loadEntries: async () => [
      { url: `https://www.crunchyroll.com/fr/series/${SERIES}/dragon-ball`, title: "Dragon Ball" },
      { url: `https://www.crunchyroll.com/fr/watch/${WATCH}/episode?x=1`, title: "Episode" },
    ],
    apiToken: "service-token",
    intervalMs: 60_000,
    maxBackoffMs: 600_000,
    now: () => clock,
    schedule: (run, delay) => {
      const entry = { run, delay, cancelled: false };
      scheduled.push(entry);
      return () => (entry.cancelled = true);
    },
    ...overrides,
  });
  return {
    catalog,
    service,
    scheduled,
    advance: (ms: number) => (clock += ms),
  };
}
const get = (service: ReturnType<typeof fixture>["service"], path: string, token?: string) =>
  service.fetch(new Request(`http://svc.test${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}));

describe("Crunchyroll service", () => {
  test("a cycle registers the observed references once and a repeat adds nothing", async () => {
    const { service, catalog } = fixture();
    const first = await service.syncOnce();
    expect(first).toMatchObject({ lastOutcome: "ok", lastError: null, consecutiveFailures: 0 });
    expect(first.lastCounts).toEqual({ references: 2, added: 2, existing: 0, episodes: 0 });
    const second = await service.syncOnce();
    expect(second.lastCounts).toEqual({ references: 2, added: 0, existing: 2, episodes: 0 });
    expect(catalog.listSources().map(source => source.id)).toEqual([
      `crunchyroll:series:${SERIES}`,
      `crunchyroll:video:${WATCH}`,
    ]);
    catalog.close();
  });

  test("failures keep only a stable code, back off exponentially up to the cap and recover", async () => {
    let fail = true;
    const { service, scheduled } = fixture({
      loadEntries: async () => {
        if (fail) throw Object.assign(new Error("secret upstream body token=abc"), { status: 503 });
        return [{ url: `https://www.crunchyroll.com/watch/${WATCH}` }];
      },
    });
    service.start();
    await Bun.sleep(0);
    await service.stop();
    expect(service.state()).toMatchObject({ lastOutcome: "failed", lastError: "upstream_503", consecutiveFailures: 1 });
    expect(JSON.stringify(service.state())).not.toContain("secret");
    expect(scheduled.map(entry => entry.delay)).toEqual([120_000]);

    const delays: number[] = [];
    for (let failures = 2; failures <= 6; failures++) {
      await service.syncOnce();
      delays.push(Math.min(600_000, 60_000 * 2 ** failures));
    }
    expect(service.state().consecutiveFailures).toBe(6);
    expect(delays.at(-1)).toBe(600_000);
    fail = false;
    expect((await service.syncOnce()).consecutiveFailures).toBe(0);
  });

  test("the loop schedules the next cycle after each run and stop cancels it", async () => {
    const { service, scheduled } = fixture();
    service.start();
    await Bun.sleep(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(60_000);
    scheduled[0]!.run();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(scheduled).toHaveLength(2);
    await service.stop();
    expect(scheduled.at(-1)!.cancelled).toBe(true);
    expect(service.state().nextRunAt).toBeNull();
  });

  test("overlapping syncs are skipped rather than run concurrently", async () => {
    const gate = Promise.withResolvers<void>();
    const { service } = fixture({
      loadEntries: async () => {
        await gate.promise;
        return [{ url: `https://www.crunchyroll.com/watch/${WATCH}` }];
      },
    });
    const running = service.syncOnce();
    expect((await service.syncOnce()).lastOutcome).toBe("skipped");
    gate.resolve();
    expect((await running).lastOutcome).toBe("ok");
    expect(service.state().runs).toBe(1);
  });

  test("an injected client expands series into episodes", async () => {
    const { service, catalog } = fixture({
      loadEntries: async () => [{ url: `https://www.crunchyroll.com/series/${SERIES}` }],
      clientFactory: () => ({
        getAnime: async () => ({ id: SERIES, title: "Dragon Ball" }),
        getSeasons: async () => ({ total: 1, items: [{ id: "SEASON0001", series_id: SERIES }] }),
        getEpisodes: async () => ({
          total: 2,
          items: [
            { id: "EPISODE01", series_id: SERIES, season_id: "SEASON0001", title: "One" },
            { id: "EPISODE02", series_id: SERIES, season_id: "SEASON0001", title: "Two" },
          ],
        }),
      }),
    });
    const state = await service.syncOnce();
    expect(state.lastOutcome).toBe("ok");
    expect(state.lastCounts?.episodes).toBe(2);
    expect(catalog.listSources().map(source => source.id)).toContain("crunchyroll:video:EPISODE02");
    catalog.close();
  });

  test("health degrades after a failure or stale success, and resolve joins the catalog with the Shenron mapping", async () => {
    const { service, advance, catalog } = fixture({ shenron: id => (id === WATCH ? { episodeId: 875 } : null) });
    expect((await get(service, "/health")).status).toBe(200);
    await service.syncOnce();
    const ok = await get(service, "/health");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", shenronResolverConfigured: true });

    const hit = await (
      await get(service, `/v1/resolve?url=${encodeURIComponent(`https://www.crunchyroll.com/fr/watch/${WATCH}/x?t=1`)}`)
    ).json();
    expect(hit).toEqual({
      contentId: WATCH,
      kind: "watch",
      url: `https://www.crunchyroll.com/watch/${WATCH}`,
      catalog: { sourceId: `crunchyroll:video:${WATCH}`, title: "Episode" },
      shenron: { episodeId: 875 },
      playback: "browser-provider-required",
    });
    const unknown = await (await get(service, "/v1/resolve?id=ZZZZZZZZZ")).json();
    expect(unknown).toMatchObject({ catalog: null, shenron: null });
    expect((await get(service, "/v1/resolve?url=https://example.com/x")).status).toBe(400);

    advance(10 * 60_000 * 60);
    const stale = await get(service, "/health");
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ status: "degraded" });
    catalog.close();
  });

  test("the index requires the service token and filters by kind", async () => {
    const { service, catalog } = fixture();
    await service.syncOnce();
    expect((await get(service, "/v1/index/sources")).status).toBe(401);
    expect((await get(service, "/v1/index/sources", "wrong")).status).toBe(401);
    const all = await (await get(service, "/v1/index/sources", "service-token")).json();
    expect(all.total).toBe(2);
    const series = await (await get(service, "/v1/index/sources?kind=series&limit=1", "service-token")).json();
    expect(series).toEqual({
      total: 1,
      sources: [
        {
          id: `crunchyroll:series:${SERIES}`,
          url: `https://www.crunchyroll.com/series/${SERIES}`,
          title: "Dragon Ball",
        },
      ],
    });
    expect((await service.fetch(new Request("http://svc.test/health", { method: "POST" }))).status).toBe(405);
    expect((await get(service, "/v1/anime/GRDV0019R")).status).toBe(401);
    catalog.close();
  });

  test("invalid intervals are rejected", () => {
    const { catalog } = fixture();
    for (const intervalMs of [0, 999, 86_400_001, 1.5])
      expect(() => createCrunchyrollService({ catalog, loadEntries: async () => [], intervalMs })).toThrow();
    catalog.close();
  });
});
