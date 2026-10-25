import { describe, expect, test } from "bun:test";
import { createVideoWebApp } from "../src/web-app";

describe("web app Crunchyroll routes", () => {
  const app = createVideoWebApp({ mediaRoot: "C:/bun/packages/bun-video/.local" });

  test("cookies route refuses GET-less mutation methods and reports presence without values", async () => {
    const response = await app.fetch(new Request("http://127.0.0.1/api/crunchyroll/cookies", { method: "DELETE" }));
    expect(response.status).toBe(405);
    const invalid = await app.fetch(
      new Request("http://127.0.0.1/api/crunchyroll/cookies", { method: "PUT", body: "{}" }),
    );
    expect(invalid.status).toBe(400);
    const status = await app.fetch(new Request("http://127.0.0.1/api/crunchyroll/cookies"));
    const body = (await status.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["count", "present"]);
  });

  test("har-map refuses relative paths", async () => {
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/crunchyroll/har-map?file=relative.har", { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });
});
