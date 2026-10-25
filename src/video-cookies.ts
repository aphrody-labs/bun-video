import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { Database } from "bun:sqlite";

export interface BrowserVideoCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite?: string;
}

function crunchyrollURL(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !(url.hostname === "crunchyroll.com" || url.hostname.endsWith(".crunchyroll.com"))
  )
    throw new TypeError("Cookie selection requires an authorized HTTPS Crunchyroll URL");
  return url;
}

/** Browser export normalization. Values remain in the private caller-owned object only. */
export function parseVideoCookies(input: unknown): readonly BrowserVideoCookie[] {
  const rows = Array.isArray(input) ? input : (input as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(rows) || rows.length > 1000) throw new TypeError("Invalid private browser cookie export");
  return rows.map((row: Record<string, unknown>) => {
    if (
      !row ||
      typeof row.name !== "string" ||
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(row.name) ||
      typeof row.value !== "string" ||
      [...row.value].some(
        character =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === ";" || character === ",",
      ) ||
      typeof row.domain !== "string" ||
      typeof row.path !== "string" ||
      !row.path.startsWith("/") ||
      /[\r\n\0]/.test(row.path)
    )
      throw new TypeError("Invalid private browser cookie fields");
    const domain = row.domain.toLowerCase();
    if (!/^\.?[a-z0-9.-]+$/.test(domain)) throw new TypeError("Invalid cookie domain");
    const host = domain.replace(/^\./, "");
    crunchyrollURL(`https://${host}/`);
    for (const name of ["hostOnly", "secure", "httpOnly", "session"])
      if (row[name] !== undefined && typeof row[name] !== "boolean") throw new TypeError("Invalid cookie flag");
    const expiry = row.expirationDate ?? row.expires;
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry)))
      throw new TypeError("Invalid cookie expiration");
    if (row.sameSite !== undefined && row.sameSite !== null && typeof row.sameSite !== "string")
      throw new TypeError("Invalid cookie sameSite field");
    const session = row.session === true || expiry === undefined || expiry === -1;
    return {
      name: row.name,
      value: row.value,
      domain,
      path: row.path,
      hostOnly: row.hostOnly === undefined ? !domain.startsWith(".") : row.hostOnly === true,
      secure: row.secure === true,
      httpOnly: row.httpOnly === true,
      session,
      ...(session ? {} : { expirationDate: expiry as number }),
      ...(row.sameSite === undefined || row.sameSite === null ? {} : { sameSite: row.sameSite }),
    };
  });
}

export async function loadVideoCookies(privatePath: string): Promise<readonly BrowserVideoCookie[]> {
  if (!isAbsolute(privatePath) || privatePath.includes("\0"))
    throw new TypeError("An absolute private cookie path is required");
  if (/\.sqlite$/i.test(privatePath)) {
    using vault = new VideoCookieVault({ path: privatePath });
    return await vault.load();
  }
  return parseVideoCookies(await Bun.file(privatePath).json());
}

export interface CookieSecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<unknown>;
}

export function defaultVideoCookieVaultPath(): string {
  const home =
    Bun.env.APHRODY_HOME ??
    join(
      Bun.env.USERPROFILE ??
        Bun.env.HOME ??
        (() => {
          throw new Error("Aphrody home required");
        })(),
      ".aphrody",
    );
  return join(home, "cookies", "crunchyroll", "cookies.sqlite");
}

/** Ciphertext-only provider store. Its AES key lives exclusively in native OS secret storage. */
export class VideoCookieVault {
  readonly db: Database;
  readonly #secrets: CookieSecretStore;
  readonly #keys = new Map<string, Promise<CryptoKey>>();
  constructor(options: { path?: string; secrets?: CookieSecretStore } = {}) {
    const path = options.path ?? defaultVideoCookieVaultPath();
    if (path !== ":memory:" && !isAbsolute(path)) throw new TypeError("Absolute isolated cookie vault path required");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS encrypted_cookies(id TEXT PRIMARY KEY,iv BLOB NOT NULL,ciphertext BLOB NOT NULL,updatedAt INTEGER NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS encrypted_configuration(id TEXT PRIMARY KEY,iv BLOB NOT NULL,ciphertext BLOB NOT NULL,updatedAt INTEGER NOT NULL)",
    );
    this.#secrets = options.secrets ?? Bun.secrets;
  }
  async #key(kind: "cookie" | "env" = "cookie"): Promise<CryptoKey> {
    const pending = this.#keys.get(kind);
    if (pending) return pending;
    const loaded = (async () => {
      const selector = { service: "bun-video", name: kind === "cookie" ? "cookie-vault.local" : "env-vault.local" };
      let encoded = await this.#secrets.get(selector);
      if (!encoded) {
        if (
          this.db
            .query(
              kind === "cookie"
                ? "SELECT id FROM encrypted_cookies LIMIT 1"
                : "SELECT id FROM encrypted_configuration LIMIT 1",
            )
            .get()
        )
          throw new Error("Cookie vault key unavailable; existing ciphertext preserved");
        const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
        await this.#secrets.set({ ...selector, value: generated });
        encoded = await this.#secrets.get(selector);
        if (encoded !== generated) throw new Error("Native cookie key storage verification failed");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== 32 || bytes.toString("base64") !== encoded)
        throw new Error("Invalid native cookie vault key");
      return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    this.#keys.set(kind, loaded);
    return loaded;
  }
  async store(input: unknown): Promise<{ encrypted: true; cookies: number }> {
    const cookies = parseVideoCookies(input);
    const key = await this.#key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode("bun-video/crunchyroll/cookies/v1"),
        tagLength: 128,
      },
      key,
      new TextEncoder().encode(JSON.stringify(input)),
    );
    this.db
      .query(
        "INSERT INTO encrypted_cookies VALUES('crunchyroll',?,?,?) ON CONFLICT(id) DO UPDATE SET iv=excluded.iv,ciphertext=excluded.ciphertext,updatedAt=excluded.updatedAt",
      )
      .run(iv, new Uint8Array(ciphertext), Date.now());
    return { encrypted: true, cookies: cookies.length };
  }
  async decode(): Promise<unknown> {
    const row = this.db
      .query<{ iv: Uint8Array; ciphertext: Uint8Array }, []>(
        "SELECT iv,ciphertext FROM encrypted_cookies WHERE id='crunchyroll'",
      )
      .get();
    if (!row) throw new Error("Encrypted Crunchyroll cookie input absent");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(row.iv),
        additionalData: new TextEncoder().encode("bun-video/crunchyroll/cookies/v1"),
        tagLength: 128,
      },
      await this.#key(),
      new Uint8Array(row.ciphertext),
    );
    const input: unknown = JSON.parse(new TextDecoder().decode(plain));
    parseVideoCookies(input);
    return input;
  }
  async load(): Promise<readonly BrowserVideoCookie[]> {
    return parseVideoCookies(await this.decode());
  }
  async storeEnvironment(text: string) {
    if (typeof text !== "string" || text.includes("\0") || text.length > 1024 * 1024)
      throw new TypeError("Invalid private environment text");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode("bun-video/environment/bun-video.env/v1"),
        tagLength: 128,
      },
      await this.#key("env"),
      new TextEncoder().encode(text),
    );
    this.db
      .query(
        "INSERT INTO encrypted_configuration VALUES('bun-video.env',?,?,?) ON CONFLICT(id) DO UPDATE SET iv=excluded.iv,ciphertext=excluded.ciphertext,updatedAt=excluded.updatedAt",
      )
      .run(iv, new Uint8Array(ciphertext), Date.now());
    if ((await this.loadEnvironment()) !== text) throw new Error("Encrypted environment verification failed");
    return { id: "bun-video.env", encrypted: true, verified: true, bytes: new TextEncoder().encode(text).length };
  }
  async loadEnvironment(): Promise<string> {
    const row = this.db
      .query<{ iv: Uint8Array; ciphertext: Uint8Array }, []>(
        "SELECT iv,ciphertext FROM encrypted_configuration WHERE id='bun-video.env'",
      )
      .get();
    if (!row) throw new Error("Encrypted Bun Video environment absent");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(row.iv),
        additionalData: new TextEncoder().encode("bun-video/environment/bun-video.env/v1"),
        tagLength: 128,
      },
      await this.#key("env"),
      new Uint8Array(row.ciphertext),
    );
    return new TextDecoder().decode(plain);
  }
  metadata() {
    const row = this.db
      .query<{ updatedAt: number; bytes: number }, []>(
        "SELECT updatedAt,length(ciphertext) AS bytes FROM encrypted_cookies WHERE id='crunchyroll'",
      )
      .get();
    return {
      provider: "crunchyroll",
      encrypted: true,
      algorithm: "AES-256-GCM",
      present: !!row,
      updatedAt: row?.updatedAt ?? null,
      encryptedBytes: row?.bytes ?? 0,
      keyStore: "native-os-secrets",
    };
  }
  delete(): void {
    this.db.query("DELETE FROM encrypted_cookies WHERE id='crunchyroll'").run();
  }
  close(): void {
    this.db.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Verify exact decoding before removing the explicitly supplied plaintext input. */
export async function migrateVideoCookies(
  privatePath: string,
  options: { path?: string; secrets?: CookieSecretStore } = {},
) {
  if (!isAbsolute(privatePath) || privatePath.includes("\0"))
    throw new TypeError("Absolute private input path required");
  const input: unknown = await Bun.file(privatePath).json();
  using vault = new VideoCookieVault(options);
  const result = await vault.store(input);
  if (!Bun.deepEquals(await vault.decode(), input))
    throw new Error("Encrypted cookie decoding verification failed; plaintext retained");
  await unlink(privatePath);
  return { ...result, path: vault.db.filename, verified: true, plaintextRemoved: true };
}

export function selectVideoCookies(
  cookies: readonly BrowserVideoCookie[],
  value: string,
  now = Date.now(),
): readonly BrowserVideoCookie[] {
  const url = crunchyrollURL(value);
  if (!Number.isFinite(now)) throw new TypeError("Invalid cookie clock");
  return parseVideoCookies(cookies)
    .filter(cookie => {
      const domain = cookie.domain.replace(/^\./, "");
      const domainMatches = cookie.hostOnly
        ? url.hostname === domain
        : url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      const pathMatches =
        url.pathname === cookie.path ||
        (url.pathname.startsWith(cookie.path) &&
          (cookie.path.endsWith("/") || url.pathname[cookie.path.length] === "/"));
      return (
        domainMatches &&
        pathMatches &&
        (!cookie.secure || url.protocol === "https:") &&
        (cookie.session || (cookie.expirationDate ?? 0) * 1000 > now)
      );
    })
    .sort((a, b) => b.path.length - a.path.length);
}

/** Sensitive header: never serialize this return value to logs or the public catalog. */
export function videoCookieHeader(cookies: readonly BrowserVideoCookie[], url: string, now = Date.now()): string {
  return selectVideoCookies(cookies, url, now)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function describeVideoCookies(cookies: readonly BrowserVideoCookie[], url: string, now = Date.now()) {
  const selected = selectVideoCookies(cookies, url, now);
  return {
    total: cookies.length,
    selected: selected.length,
    expired: cookies.filter(cookie => !cookie.session && (cookie.expirationDate ?? 0) * 1000 <= now).length,
    names: selected.map(cookie => cookie.name),
    authenticationQualified: false,
  };
}

/** Read-only page fetch; each allowed redirect reselects the private cookies for its exact URL. */
export async function probeCrunchyrollCookies(
  privatePath: string,
  options: { url?: string; signal?: AbortSignal } = {},
) {
  let url = crunchyrollURL(options.url ?? "https://www.crunchyroll.com/").href;
  const cookies = await loadVideoCookies(privatePath);
  const summary = describeVideoCookies(cookies, url);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  const output = join(privatePath, "..", "page-response.json");
  const responses: {
    capturedAt: string;
    url: string;
    status: number;
    headers: [string, string][];
    body: string;
    encoding: string;
  }[] = [];
  let bytes = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: { Cookie: videoCookieHeader(cookies, url) },
      redirect: "manual",
      signal,
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new RangeError("Cookie probe body exceeds 32 MiB");
        chunks.push(chunk);
      }
    bytes += size;
    responses.push({
      capturedAt: new Date().toISOString(),
      url,
      status: response.status,
      headers: [...response.headers],
      body: Buffer.concat(chunks).toString("base64"),
      encoding: "base64",
    });
    await Bun.write(output, JSON.stringify({ responses }));
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    url = crunchyrollURL(new URL(location, url).href).href;
  }
  return {
    ...summary,
    status: responses.at(-1)!.status,
    statuses: responses.map(response => response.status),
    requests: responses.length,
    bytes,
    evidenceRef: output,
    phase: "http-page" as const,
    authenticationQualified: false,
  };
}
