import { describe, expect, test } from "bun:test";
import { loadCrunchyrollCookies, parseCookieExport, storeCrunchyrollCookies } from "../src/crunchyroll-cookies";
import type { JsonSecretStore } from "../src/secrets";

function memoryStore(): JsonSecretStore {
  const map = new Map<string, string>();
  const key = (r: { service: string; name: string }) => `${r.service}/${r.name}`;
  return {
    async get(r) {
      return map.get(key(r)) ?? null;
    },
    async set(r) {
      map.set(key(r), r.value);
    },
    async delete(r) {
      return map.delete(key(r));
    },
  };
}

describe("crunchyroll cookies in the secret store", () => {
  const sample = JSON.stringify([
    {
      domain: ".crunchyroll.com",
      name: "device_id",
      value: "abc",
      path: "/",
      secure: true,
      sameSite: "lax",
      expirationDate: 1826901410,
    },
    { domain: "www.crunchyroll.com", name: "c_locale", value: "fr-FR", path: "/" },
  ]);

  test("rejects a non-array or malformed export", () => {
    expect(() => parseCookieExport("{}")).toThrow("JSON array");
    expect(() => parseCookieExport('[{"name":"x"}]')).toThrow("missing");
  });

  test("stores and reloads the cookies from the secret store", async () => {
    const store = memoryStore();
    const meta = await storeCrunchyrollCookies(sample, store);
    expect(meta.count).toBe(2);
    const loaded = await loadCrunchyrollCookies(store);
    expect(loaded?.map(c => c.name)).toEqual(["device_id", "c_locale"]);
    expect(loaded?.[0]?.secure).toBe(true);
  });
});
