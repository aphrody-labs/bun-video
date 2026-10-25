import { describe, expect, test } from "bun:test";
import { normalizeCrunchyrollPath } from "../src/crunchyroll-har-map";
import { tempDir } from "../../../test/harness";
import { join } from "node:path";

describe("crunchyroll HAR map", () => {
  test("normalises ids in API paths", () => {
    expect(normalizeCrunchyrollPath("/content/v2/cms/series/GXJ3DXE2Y/seasons")).toBe(
      "/content/v2/cms/series/:id/seasons",
    );
    expect(normalizeCrunchyrollPath("/content/v2/cms/objects/1234567")).toBe("/content/v2/cms/objects/:id");
    expect(normalizeCrunchyrollPath("/auth/v1/token")).toBe("/auth/v1/token");
  });
});

describe("crunchyroll HAR map on a synthetic capture", () => {
  test("maps hosts, CDN and the encrypted DASH manifest", async () => {
    const { mapCrunchyrollHar } = await import("../src/crunchyroll-har-map");
    const entry = (url: string, mimeType: string, text: string) => ({
      request: { method: "GET", url },
      response: { status: 200, content: { mimeType, text } },
    });
    using directory = tempDir("crunchyroll-har-map", {
      "fixture.har": JSON.stringify({
        log: {
          entries: [
            entry("https://www.crunchyroll.com/auth/v1/token", "application/json", "{}"),
            entry("https://www.crunchyroll.com/content/v2/cms/series/FIXTURE1", "application/json", "{}"),
            entry(
              "https://vod-gcp.crunchyrollcdn.com/fixture.mpd",
              "application/dash+xml",
              '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>' +
                [1, 2, 3, 4].map(id => `<Representation id="${id}" codecs="avc1.640028"/>`).join("") +
                "</AdaptationSet></Period></MPD>",
            ),
          ],
        },
      }),
    });
    const map = await mapCrunchyrollHar(join(String(directory), "fixture.har"));
    expect(map.apiHosts[0]?.host).toBe("www.crunchyroll.com");
    expect(map.cdn).toContain("vod-gcp.crunchyrollcdn.com");
    expect(map.manifests).toEqual([
      { host: "vod-gcp.crunchyrollcdn.com", kind: "dash", encrypted: true, representations: 4 },
    ]);
    expect(map.jsonResponses).toBe(2);
  });
});
