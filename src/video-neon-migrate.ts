import { Database } from "bun:sqlite";

type Table = { name: string; key: string; columns: readonly string[]; create: string; optional?: boolean };
type Row = Record<string, string | number | null>;
export type VideoCatalogSql = {
  unsafe<T = unknown>(query: string, parameters?: readonly unknown[]): PromiseLike<T>;
  begin<T>(callback: (transaction: VideoCatalogSql) => T | Promise<T>): Promise<T>;
};

const tables: readonly Table[] = [
  {
    name: "providers",
    key: "id",
    columns: ["id", "name", "family", "sourceRef", "status"],
    create:
      '"id" text PRIMARY KEY,"name" text NOT NULL,"family" text NOT NULL,"sourceRef" text,"status" text NOT NULL DEFAULT \'not_tested\' CHECK("status" IN (\'passed\',\'failed\',\'blocked\',\'not_tested\'))',
  },
  {
    name: "capabilities",
    key: "id",
    columns: ["id", "family", "exportName", "sourceRef", "status"],
    create:
      '"id" text PRIMARY KEY,"family" text NOT NULL,"exportName" text NOT NULL,"sourceRef" text NOT NULL,"status" text NOT NULL DEFAULT \'not_tested\' CHECK("status" IN (\'passed\',\'failed\',\'blocked\',\'not_tested\'))',
  },
  {
    name: "sources",
    key: "id",
    columns: ["id", "url", "privateRef", "providerId", "kind", "title"],
    create:
      '"id" text PRIMARY KEY,"url" text,"privateRef" text,"providerId" text REFERENCES bun_video.providers("id"),"kind" text NOT NULL,"title" text,CHECK("url" IS NOT NULL OR "privateRef" IS NOT NULL)',
  },
  {
    name: "jobs",
    key: "id",
    columns: ["id", "sourceId", "engine", "status", "workerId", "config", "error", "result", "createdAt", "updatedAt"],
    create:
      '"id" text PRIMARY KEY,"sourceId" text NOT NULL REFERENCES bun_video.sources("id"),"engine" text NOT NULL,"status" text NOT NULL CHECK("status" IN (\'queued\',\'running\',\'completed\',\'failed\',\'cancelled\')),"workerId" text,"config" text NOT NULL,"error" text,"result" text,"createdAt" bigint NOT NULL,"updatedAt" bigint NOT NULL',
  },
  {
    name: "artifacts",
    key: "id",
    columns: ["id", "jobId", "kind", "path", "sha256", "metadata"],
    create:
      '"id" text PRIMARY KEY,"jobId" text NOT NULL REFERENCES bun_video.jobs("id"),"kind" text NOT NULL,"path" text NOT NULL,"sha256" text,"metadata" text NOT NULL',
  },
  {
    name: "frames",
    key: "id",
    columns: ["id", "jobId", "frame", "artifactId", "timestampMs"],
    create:
      '"id" text PRIMARY KEY,"jobId" text NOT NULL REFERENCES bun_video.jobs("id"),"frame" integer NOT NULL CHECK("frame">=0),"artifactId" text NOT NULL REFERENCES bun_video.artifacts("id"),"timestampMs" double precision,UNIQUE("jobId","frame")',
  },
  {
    name: "qualifications",
    key: "id",
    columns: ["id", "sourceId", "providerId", "capabilityId", "status", "evidenceRef", "detail", "createdAt"],
    create:
      '"id" text PRIMARY KEY,"sourceId" text REFERENCES bun_video.sources("id"),"providerId" text REFERENCES bun_video.providers("id"),"capabilityId" text REFERENCES bun_video.capabilities("id"),"status" text NOT NULL CHECK("status" IN (\'passed\',\'failed\',\'blocked\',\'not_tested\')),"evidenceRef" text,"detail" text,"createdAt" bigint NOT NULL',
  },
  {
    name: "capture_entries",
    key: "id",
    columns: [
      "id",
      "sourceId",
      "entryIndex",
      "method",
      "host",
      "mimeType",
      "status",
      "encodedBytes",
      "bytes",
      "bodyRef",
      "manifestKind",
      "encrypted",
      "complete",
    ],
    create:
      '"id" text PRIMARY KEY,"sourceId" text NOT NULL REFERENCES bun_video.sources("id"),"entryIndex" integer NOT NULL,"method" text NOT NULL,"host" text NOT NULL,"mimeType" text NOT NULL,"status" integer NOT NULL,"encodedBytes" bigint NOT NULL,"bytes" bigint NOT NULL,"bodyRef" text,"manifestKind" text,"encrypted" integer NOT NULL,"complete" integer NOT NULL,UNIQUE("sourceId","entryIndex")',
    optional: true,
  },
  {
    name: "captured_resources",
    key: "id",
    columns: ["id", "sourceId", "entryIndex", "kind", "bodyRef", "bytes"],
    create:
      '"id" text PRIMARY KEY,"sourceId" text NOT NULL REFERENCES bun_video.sources("id"),"entryIndex" integer NOT NULL,"kind" text NOT NULL,"bodyRef" text NOT NULL,"bytes" bigint NOT NULL,UNIQUE("sourceId","entryIndex")',
    optional: true,
  },
  {
    name: "schema_migrations",
    key: "version",
    columns: ["version", "appliedAt"],
    create: '"version" integer PRIMARY KEY,"appliedAt" bigint NOT NULL',
  },
  {
    name: "video_site_exports",
    key: "id",
    columns: ["id", "format", "path", "createdAt", "documents", "records", "bytes", "sha256"],
    create:
      '"id" text PRIMARY KEY,"format" text NOT NULL,"path" text NOT NULL,"createdAt" bigint NOT NULL,"documents" bigint NOT NULL,"records" bigint NOT NULL,"bytes" bigint NOT NULL,"sha256" text NOT NULL',
    optional: true,
  },
];

export type VideoCatalogSnapshot = {
  readonly tables: readonly { readonly name: string; readonly rows: readonly Row[] }[];
  readonly counts: Readonly<Record<string, number>>;
  readonly digest: string;
};

const quote = (name: string) => `"${name}"`;
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function fingerprint(data: VideoCatalogSnapshot["tables"]): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const item of data) {
    const table = tables.find(candidate => candidate.name === item.name);
    if (!table) throw new TypeError("Unexpected video catalog table");
    hash.update(`${table.name}\0${table.columns.join(",")}\n`);
    const rows = [...item.rows].sort((a, b) => compare(String(a[table.key]), String(b[table.key])));
    for (const row of rows)
      hash.update(
        JSON.stringify(table.columns.map(column => (row[column] === null ? null : String(row[column])))) + "\n",
      );
  }
  return hash.digest("hex");
}

/** Reads one consistent WAL snapshot into memory; no source file or private values are logged. */
export function snapshotVideoCatalog(path: string): VideoCatalogSnapshot {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (check?.quick_check !== "ok") throw new Error("Video SQLite integrity check failed");
    const data = tables.map(table => {
      const found = db
        .query<{ name: string }, []>(`PRAGMA table_info(${quote(table.name)})`)
        .all()
        .map(row => row.name);
      if (found.length === 0 && table.optional) return { name: table.name, rows: [] };
      if (found.join("\0") !== table.columns.join("\0")) throw new Error(`Video SQLite schema mismatch: ${table.name}`);
      const rows = db.query<Row, []>(`SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)}`).all();
      return { name: table.name, rows };
    });
    db.exec("ROLLBACK");
    return {
      tables: data,
      counts: Object.fromEntries(data.map(table => [table.name, table.rows.length])),
      digest: fingerprint(data),
    };
  } finally {
    db.close();
  }
}

/** Imports into an empty dedicated Neon schema, verifies every row, then commits atomically. */
export async function importVideoCatalog(
  sql: VideoCatalogSql,
  snapshot: VideoCatalogSnapshot,
): Promise<{ counts: Record<string, number>; digest: string }> {
  if (
    snapshot.tables.map(table => table.name).join("\0") !== tables.map(table => table.name).join("\0") ||
    fingerprint(snapshot.tables) !== snapshot.digest
  )
    throw new TypeError("Video catalog snapshot was changed after capture");
  return sql.begin(async transaction => {
    await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('aphrody:bun-video:catalog-import'))");
    await transaction.unsafe("CREATE SCHEMA IF NOT EXISTS bun_video");
    const existing = await transaction.unsafe<{ total: number }[]>(
      "SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = 'bun_video'",
    );
    if (existing[0]?.total !== 0) throw new Error("Neon bun_video schema is not empty");
    const verified: { name: string; rows: Row[] }[] = [];
    for (const table of tables) {
      const source = snapshot.tables.find(item => item.name === table.name)!;
      await transaction.unsafe(`CREATE TABLE bun_video.${quote(table.name)} (${table.create})`);
      for (let offset = 0; offset < source.rows.length; offset += 100) {
        const page = source.rows.slice(offset, offset + 100);
        const parameters = page.flatMap(row => table.columns.map(column => row[column]));
        const groups = page.map(
          (_, index) =>
            `(${table.columns.map((_, column) => `$${index * table.columns.length + column + 1}`).join(",")})`,
        );
        await transaction.unsafe(
          `INSERT INTO bun_video.${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES ${groups.join(",")}`,
          parameters,
        );
      }
      const rows = await transaction.unsafe<Row[]>(
        `SELECT ${table.columns.map(quote).join(",")} FROM bun_video.${quote(table.name)}`,
      );
      if (rows.length !== source.rows.length) throw new Error(`Video catalog row count mismatch: ${table.name}`);
      verified.push({ name: table.name, rows });
    }
    for (const statement of [
      'CREATE INDEX jobs_status ON bun_video.jobs("status")',
      'CREATE INDEX qualifications_source ON bun_video.qualifications("sourceId")',
      'CREATE INDEX artifacts_job ON bun_video.artifacts("jobId")',
      'CREATE INDEX capture_entries_source ON bun_video.capture_entries("sourceId")',
    ])
      await transaction.unsafe(statement);
    const digest = fingerprint(verified);
    if (digest !== snapshot.digest) throw new Error("Video catalog Neon read-back digest mismatch");
    return { counts: { ...snapshot.counts }, digest };
  });
}
