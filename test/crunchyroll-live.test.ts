// Target of the repo's live tests: Crunchyroll, the official source of Dragon Ball Super: Beerus.
//
// - The contract tests always run: URL parsing and the metadata API bridge against fixtures shaped like the provider.
// - The live tests read the public Crunchyroll pages. Crunchyroll puts a Cloudflare challenge in front of automated
//   clients; the probe below classifies the answer as `open`, `challenge` or `unreachable`. The page tests run only when
//   it is `open`, a challenge is reported as such (never bypassed), and only `unreachable` fails the suite.
import { describe, expect, test } from "bun:test";
import { createCrunchyrollApi } from "../src/crunchyroll-api";
import { parseCrunchyrollSeriesUrl, parseCrunchyrollWatchUrl } from "../src/crunchyroll";

const WATCH =
  Bun.env.CRUNCHYROLL_TEST_WATCH_URL ?? "https://www.crunchyroll.com/fr/watch/GE00389313JAJP/the-god-who-destroys";
const SERIES =
  Bun.env.CRUNCHYROLL_TEST_SERIES_URL ?? "https://www.crunchyroll.com/fr/series/GT00389311/dragon-ball-super-beerus";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

type State = "open" | "challenge" | "unreachable";
async function probe(url: string): Promise<{ state: State; status: number; html: string }> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await response.text();
    const challenged =
      response.headers.get("cf-mitigated") === "challenge" ||
      response.status === 403 ||
      /<title>Just a moment/i.test(html);
    return { state: challenged ? "challenge" : response.ok ? "open" : "unreachable", status: response.status, html };
  } catch {
    return { state: "unreachable", status: 0, html: "" };
  }
}

const watch = await probe(WATCH);
const series = await probe(SERIES);
console.warn(
  `crunchyroll-live: watch page ${watch.state} (HTTP ${watch.status}), series page ${series.state} (HTTP ${series.status})`,
);
const openOnly = (state: State) => (state === "open" ? test : test.skip);

describe("Crunchyroll contract (always runs)", () => {
  test("the official Beerus URLs parse to their content ids", () => {
    expect(JSON.stringify(parseCrunchyrollWatchUrl(WATCH))).toContain("GE00389313JAJP");
    expect(JSON.stringify(parseCrunchyrollSeriesUrl(SERIES))).toContain("GT00389311");
  });

  test("a foreign host is refused as a Crunchyroll URL", () => {
    expect(() => parseCrunchyrollWatchUrl("https://evil.example/fr/watch/GE00389313JAJP/x")).toThrow();
  });

  test("the metadata bridge returns series, seasons and episodes from the provider client", async () => {
    const episode = {
      id: "GE00389313JAJP",
      title: "The God Who Destroys",
      episode_number: 1,
      duration_ms: 1_397_000,
      audio_locale: "ja-JP",
      subtitle_locales: ["fr-FR"],
    };
    const api = createCrunchyrollApi({
      apiToken: "test-token",
      clientFactory: () =>
        ({
          getAnime: async () => ({ data: [{ id: "GT00389311", title: "Dragon Ball Super: Beerus" }] }),
          getSeasons: async () => ({ data: [{ id: "GR00389312", season_number: 1 }] }),
          getEpisodes: async () => ({ data: [episode] }),
          search: async () => ({ data: [] }),
        }) as any,
    });
    const get = async (path: string) =>
      (
        await api(new Request(`http://localhost${path}`, { headers: { authorization: "Bearer test-token" } }))
      ).json() as Promise<any>;
    expect((await get("/v1/anime/GT00389311")).data[0].id).toBe("GT00389311");
    expect((await get("/v1/anime/GT00389311/seasons")).data[0].id).toBe("GR00389312");
    expect((await get("/v1/seasons/GR00389312/episodes")).data[0].episode_number).toBe(1);
  });
});

describe("Crunchyroll live pages", () => {
  test("the official pages are reachable (a bot challenge counts as reachable and is reported)", () => {
    expect(watch.state).not.toBe("unreachable");
    expect(series.state).not.toBe("unreachable");
  });

  openOnly(watch.state)("the Beerus episode page is served as HTML", () => {
    expect(watch.status).toBe(200);
    expect(watch.html).toContain("<title>");
  });

  openOnly(series.state)("the Beerus series page is served as HTML", () => {
    expect(series.status).toBe(200);
    expect(series.html.toLowerCase()).toContain("<html");
  });

  const chrome = { type: "chrome", url: false, argv: ["--no-sandbox"] };
  openOnly(watch.state)(
    "Bun.WebView renders the episode page past the challenge-free shell",
    async () => {
      await using view = new (Bun as any).WebView({ width: 1280, height: 800, backend: chrome });
      await view.navigate(WATCH);
      await Bun.sleep(4000);
      const title = String(await view.evaluate("document.title"));
      expect(title).not.toMatch(/just a moment|un instant/i);
      expect(title.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
