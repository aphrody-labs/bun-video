import { expect, test } from "bun:test";
import {
  parseVideoCookies,
  selectVideoCookies,
  describeVideoCookies,
  videoCookieHeader,
  VideoCookieVault,
} from "../src/video-cookies";

const cookies = () =>
  parseVideoCookies([
    { name: "domain", value: "unit", domain: ".crunchyroll.com", path: "/", secure: true, expirationDate: 2000 },
    { name: "host", value: "unit", domain: "www.crunchyroll.com", hostOnly: true, path: "/watch", session: true },
    { name: "expired", value: "unit", domain: ".crunchyroll.com", path: "/", expirationDate: 1 },
  ]);

test("browser cookies honor domain, host-only, path boundaries and expiry", () => {
  expect(
    selectVideoCookies(cookies(), "https://www.crunchyroll.com/watch/ABC", 2000).map(cookie => cookie.name),
  ).toEqual(["host", "domain"]);
  expect(videoCookieHeader(cookies(), "https://beta-api.crunchyroll.com/watch/ABC", 2000)).toBe("domain=unit");
  expect(selectVideoCookies(cookies(), "https://www.crunchyroll.com/watcher", 2000).map(cookie => cookie.name)).toEqual(
    ["domain"],
  );
  const report = describeVideoCookies(cookies(), "https://www.crunchyroll.com/", 2000);
  expect(report.expired).toBe(1);
  expect(JSON.stringify(report)).not.toContain("unit");
});

test("cookie owner rejects unrelated origins and header injection", () => {
  expect(() => videoCookieHeader(cookies(), "https://archive.org/", 2000)).toThrow("Crunchyroll");
  expect(() => videoCookieHeader(cookies(), "http://www.crunchyroll.com/", 2000)).toThrow("HTTPS");
  expect(() =>
    parseVideoCookies([{ name: "x", value: "bad\r\nvalue", domain: ".crunchyroll.com", path: "/" }]),
  ).toThrow("fields");
});

test("cookie vault stores only authenticated ciphertext with fresh IVs and a separate key", async () => {
  let secret: string | null = null;
  const secrets = {
    async get() {
      return secret;
    },
    async set(input: { value: string }) {
      secret = input.value;
    },
  };
  using vault = new VideoCookieVault({ path: ":memory:", secrets });
  const original = cookies();
  await vault.store(original);
  expect(await vault.decode()).toEqual(original);
  const first = vault.db
    .query<{ iv: Uint8Array; ciphertext: Uint8Array }, []>("SELECT iv,ciphertext FROM encrypted_cookies")
    .get()!;
  expect(Buffer.from(first.ciphertext).toString()).not.toContain("unit");
  expect(
    vault.db
      .query("PRAGMA table_info(encrypted_cookies)")
      .all()
      .map((row: any) => row.name),
  ).toEqual(["id", "iv", "ciphertext", "updatedAt"]);
  expect(vault.metadata().algorithm).toBe("AES-256-GCM");
  await vault.store(original);
  const second = vault.db
    .query<{ iv: Uint8Array; ciphertext: Uint8Array }, []>("SELECT iv,ciphertext FROM encrypted_cookies")
    .get()!;
  expect(second.iv).not.toEqual(first.iv);
  const tampered = new Uint8Array(second.ciphertext);
  tampered[0] ^= 1;
  vault.db.query("UPDATE encrypted_cookies SET ciphertext=?").run(tampered);
  await expect(vault.decode()).rejects.toThrow();
  vault.delete();
  expect(vault.metadata().present).toBe(false);
  await expect(vault.load()).rejects.toThrow("absent");
});

test("encrypted environment preserves exact text and uses a distinct native key selector", async () => {
  const keys = new Map<string, string>();
  const secrets = {
    async get(input: { name: string }) {
      return keys.get(input.name) ?? null;
    },
    async set(input: { name: string; value: string }) {
      keys.set(input.name, input.value);
    },
  };
  using vault = new VideoCookieVault({ path: ":memory:", secrets });
  await vault.store(cookies());
  const text = "BUN_VIDEO_FFMPEG=qualified-path\nBUN_VIDEO_PACKAGE_ROOT=qualified-root\n";
  await vault.storeEnvironment(text);
  expect(await vault.loadEnvironment()).toBe(text);
  expect([...keys.keys()].sort()).toEqual(["cookie-vault.local", "env-vault.local"]);
  expect(keys.get("cookie-vault.local")).not.toBe(keys.get("env-vault.local"));
  const row = vault.db.query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM encrypted_configuration").get()!;
  expect(Buffer.from(row.ciphertext).toString()).not.toContain("BUN_VIDEO_FFMPEG");
  const changed = new Uint8Array(row.ciphertext);
  changed[changed.length - 1] ^= 1;
  vault.db.query("UPDATE encrypted_configuration SET ciphertext=?").run(changed);
  await expect(vault.loadEnvironment()).rejects.toThrow();
});
