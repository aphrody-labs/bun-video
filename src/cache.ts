import { Database } from "bun:sqlite";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface CacheOptions {
  readonly sqlitePath: string;
  readonly redis?: RedisLike;
  readonly namespace?: string;
  readonly ttlSeconds?: number;
}

/** Persistent crawler cache shared by Obscura/Chrome and Bun Video workers. */
export class CrawlerCache {
  readonly #db: Database;
  readonly #redis?: RedisLike;
  readonly #prefix: string;
  readonly #ttl: number;

  constructor(options: CacheOptions) {
    this.#db = new Database(options.sqlitePath, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS crawler_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
    );
    this.#redis = options.redis;
    this.#prefix = options.namespace ? `${options.namespace}:` : "bun-video:";
    this.#ttl = options.ttlSeconds ?? 3600;
  }

  async get<T>(key: string): Promise<T | null> {
    const namespaced = this.#prefix + key;
    const redisValue = await this.#redis?.get(namespaced);
    if (redisValue) return JSON.parse(redisValue) as T;
    const row = this.#db
      .query<{ value: string; expires_at: number | null }, [string]>(
        "SELECT value, expires_at FROM crawler_cache WHERE key = ?1",
      )
      .get(namespaced);
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return null;
    return JSON.parse(row.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = this.#ttl): Promise<void> {
    const namespaced = this.#prefix + key;
    const serialized = JSON.stringify(value);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.#db
      .query(
        "INSERT INTO crawler_cache (key, value, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
      )
      .run(namespaced, serialized, expiresAt);
    if (this.#redis) await this.#redis.set(namespaced, serialized, "EX", ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    const namespaced = this.#prefix + key;
    this.#db.query("DELETE FROM crawler_cache WHERE key = ?1").run(namespaced);
    await this.#redis?.del(namespaced);
  }

  close(): void {
    this.#db.close();
  }
}
