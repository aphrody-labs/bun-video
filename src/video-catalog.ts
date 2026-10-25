/// <reference path="./media-runtime.d.ts" />
import { Database } from "bun:sqlite";
import { dirname, join, resolve, relative } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export type VideoJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type QualificationStatus = "passed" | "failed" | "blocked" | "not_tested";
export interface VideoSource {
  id: string;
  url: string | null;
  privateRef: string | null;
  providerId: string | null;
  kind: string;
  title: string | null;
}
export interface VideoJob {
  id: string;
  sourceId: string;
  engine: string;
  status: VideoJobStatus;
  workerId: string | null;
  config: unknown;
  error: string | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}
export interface VideoProvider {
  id: string;
  name: string;
  family: string;
  sourceRef: string | null;
  status: QualificationStatus;
}
export interface VideoCapability {
  id: string;
  family: string;
  exportName: string;
  sourceRef: string;
  status: QualificationStatus;
}
export interface VideoQualification {
  id: string;
  sourceId: string | null;
  providerId: string | null;
  capabilityId: string | null;
  status: QualificationStatus;
  evidenceRef: string | null;
  detail: string | null;
  createdAt: number;
}
export interface VideoArtifact {
  id: string;
  jobId: string;
  kind: string;
  path: string;
  sha256: string | null;
  metadata: unknown;
}

export function defaultVideoCatalogPath(): string {
  const home =
    Bun.env.APHRODY_HOME ??
    join(
      Bun.env.USERPROFILE ??
        Bun.env.HOME ??
        (() => {
          throw new Error("A home directory or explicit catalog path is required");
        })(),
      ".aphrody",
    );
  return join(home, "data", "bun-video", "video.sqlite");
}

function parseJob(row: Record<string, unknown> | null): VideoJob | null {
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(String(row.config)),
    result: row.result === null ? null : JSON.parse(String(row.result)),
  } as unknown as VideoJob;
}

/** Private workflow metadata. Cookies, credentials and HAR bodies belong in separate protected files. */
export class VideoCatalog {
  readonly db: Database;

  constructor(path: string = defaultVideoCatalogPath()) {
    // The cutover marker protects the production catalog only; explicit fixture files stay usable.
    const production = path === defaultVideoCatalogPath();
    if (
      path !== ":memory:" &&
      (Bun.env.BUN_VIDEO_CATALOG_BACKEND === "neon" ||
        (production && existsSync(join(dirname(dirname(dirname(path))), "config", "bun-video-neon.active"))))
    )
      throw new Error("Bun Video Neon cutover forbids SQLite writers");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)",
    );
    this.db.transaction(() => {
      if (this.db.query("SELECT version FROM schema_migrations WHERE version=1").get()) return;
      this.db.exec(`
        CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,family TEXT NOT NULL,sourceRef TEXT,status TEXT NOT NULL DEFAULT 'not_tested' CHECK(status IN ('passed','failed','blocked','not_tested')));
        CREATE TABLE capabilities(id TEXT PRIMARY KEY,family TEXT NOT NULL,exportName TEXT NOT NULL,sourceRef TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'not_tested' CHECK(status IN ('passed','failed','blocked','not_tested')));
        CREATE TABLE sources(id TEXT PRIMARY KEY,url TEXT,privateRef TEXT,providerId TEXT REFERENCES providers(id),kind TEXT NOT NULL,title TEXT,CHECK(url IS NOT NULL OR privateRef IS NOT NULL));
        CREATE TABLE jobs(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL REFERENCES sources(id),engine TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),workerId TEXT,config TEXT NOT NULL,error TEXT,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
        CREATE TABLE artifacts(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES jobs(id),kind TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT,metadata TEXT NOT NULL);
        CREATE TABLE frames(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES jobs(id),frame INTEGER NOT NULL CHECK(frame>=0),artifactId TEXT NOT NULL REFERENCES artifacts(id),timestampMs REAL,UNIQUE(jobId,frame));
        CREATE TABLE qualifications(id TEXT PRIMARY KEY,sourceId TEXT REFERENCES sources(id),providerId TEXT REFERENCES providers(id),capabilityId TEXT REFERENCES capabilities(id),status TEXT NOT NULL CHECK(status IN ('passed','failed','blocked','not_tested')),evidenceRef TEXT,detail TEXT,createdAt INTEGER NOT NULL);
        CREATE INDEX jobs_status ON jobs(status); CREATE INDEX qualifications_source ON qualifications(sourceId); CREATE INDEX artifacts_job ON artifacts(jobId);
      `);
      this.db.query("INSERT INTO schema_migrations VALUES(1,?)").run(Date.now());
    })();
  }

  close(): void {
    this.db.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }

  registerProvider(
    input: Omit<VideoProvider, "status" | "sourceRef"> & Partial<Pick<VideoProvider, "status" | "sourceRef">>,
  ): VideoProvider {
    this.db
      .query(
        "INSERT INTO providers VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,family=excluded.family,sourceRef=excluded.sourceRef",
      )
      .run(input.id, input.name, input.family, input.sourceRef ?? null, input.status ?? "not_tested");
    return this.db.query<VideoProvider, [string]>("SELECT * FROM providers WHERE id=?").get(input.id)!;
  }
  listProviders(): VideoProvider[] {
    return this.db.query<VideoProvider, []>("SELECT * FROM providers ORDER BY id").all();
  }

  registerSource(input: {
    id?: string;
    url?: string;
    privateRef?: string;
    providerId?: string;
    kind?: "url" | "file" | "capture";
    title?: string;
  }): VideoSource {
    if (!input.url && !input.privateRef) throw new TypeError("A public URL or private file reference is required");
    if (input.url) {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new TypeError("Store signed URLs and credential-bearing URLs in a protected file via privateRef");
    }
    const id = input.id ?? crypto.randomUUID();
    this.db
      .query("INSERT INTO sources VALUES(?,?,?,?,?,?)")
      .run(
        id,
        input.url ?? null,
        input.privateRef ?? null,
        input.providerId ?? null,
        input.kind ?? (input.url ? "url" : "file"),
        input.title ?? null,
      );
    return this.db.query<VideoSource, [string]>("SELECT * FROM sources WHERE id=?").get(id)!;
  }
  listSources(): VideoSource[] {
    return this.db.query<VideoSource, []>("SELECT * FROM sources ORDER BY id").all();
  }

  addJob(input: { id?: string; sourceId: string; engine: string; config?: unknown }): VideoJob {
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    this.db
      .query("INSERT INTO jobs VALUES(?,?,?,'queued',NULL,?,NULL,NULL,?,?)")
      .run(id, input.sourceId, input.engine, JSON.stringify(input.config ?? {}), now, now);
    return this.getJob(id)!;
  }
  getJob(id: string): VideoJob | null {
    return parseJob(this.db.query<Record<string, unknown>, [string]>("SELECT * FROM jobs WHERE id=?").get(id));
  }
  updateJob(
    id: string,
    patch: { status: VideoJobStatus; workerId?: string; error?: string; result?: unknown },
  ): VideoJob {
    const previous = this.getJob(id);
    if (!previous) throw new Error(`Unknown video job: ${id}`);
    this.db
      .query("UPDATE jobs SET status=?,workerId=?,error=?,result=?,updatedAt=? WHERE id=?")
      .run(
        patch.status,
        patch.workerId ?? previous.workerId,
        patch.error ?? previous.error,
        JSON.stringify(patch.result ?? previous.result),
        Date.now(),
        id,
      );
    return this.getJob(id)!;
  }
  listJobs(status?: VideoJobStatus): VideoJob[] {
    const rows = status
      ? this.db
          .query<Record<string, unknown>, [string]>("SELECT * FROM jobs WHERE status=? ORDER BY createdAt,id")
          .all(status)
      : this.db.query<Record<string, unknown>, []>("SELECT * FROM jobs ORDER BY createdAt,id").all();
    return rows.map(row => parseJob(row)!);
  }
  recordArtifact(
    input: Omit<VideoArtifact, "id" | "sha256" | "metadata"> & { id?: string; sha256?: string; metadata?: unknown },
  ): VideoArtifact {
    const row = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      sha256: input.sha256 ?? null,
      metadata: input.metadata ?? {},
    };
    this.db
      .query("INSERT INTO artifacts VALUES(?,?,?,?,?,?)")
      .run(row.id, row.jobId, row.kind, row.path, row.sha256, JSON.stringify(row.metadata));
    return row;
  }
  listArtifacts(jobId?: string): VideoArtifact[] {
    const rows = jobId
      ? this.db.query<Record<string, unknown>, [string]>("SELECT * FROM artifacts WHERE jobId=? ORDER BY id").all(jobId)
      : this.db.query<Record<string, unknown>, []>("SELECT * FROM artifacts ORDER BY id").all();
    return rows.map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) }) as unknown as VideoArtifact);
  }
  recordFrame(input: { jobId: string; frame: number; artifactId: string; timestampMs?: number }): string {
    const artifact = this.db
      .query<{ jobId: string }, [string]>("SELECT jobId FROM artifacts WHERE id=?")
      .get(input.artifactId);
    if (artifact?.jobId !== input.jobId) throw new TypeError("Frame artifact must belong to the same job");
    const id = crypto.randomUUID();
    this.db
      .query("INSERT INTO frames VALUES(?,?,?,?,?)")
      .run(id, input.jobId, input.frame, input.artifactId, input.timestampMs ?? null);
    return id;
  }
  listFrames(jobId: string): { frame: number; artifactId: string; timestampMs: number | null }[] {
    return this.db
      .query<{ frame: number; artifactId: string; timestampMs: number | null }, [string]>(
        "SELECT frame,artifactId,timestampMs FROM frames WHERE jobId=? ORDER BY frame",
      )
      .all(jobId);
  }
  recordQualification(input: {
    sourceId?: string;
    providerId?: string;
    capabilityId?: string;
    status: QualificationStatus;
    evidenceRef?: string;
    detail?: string;
  }): VideoQualification {
    const row = {
      id: crypto.randomUUID(),
      sourceId: input.sourceId ?? null,
      providerId: input.providerId ?? null,
      capabilityId: input.capabilityId ?? null,
      status: input.status,
      evidenceRef: input.evidenceRef ?? null,
      detail: input.detail ?? null,
      createdAt: Date.now(),
    };
    this.db
      .query("INSERT INTO qualifications VALUES(?,?,?,?,?,?,?,?)")
      .run(
        row.id,
        row.sourceId,
        row.providerId,
        row.capabilityId,
        row.status,
        row.evidenceRef,
        row.detail,
        row.createdAt,
      );
    return row;
  }
  listQualifications(sourceId?: string): VideoQualification[] {
    return sourceId
      ? this.db
          .query<VideoQualification, [string]>("SELECT * FROM qualifications WHERE sourceId=? ORDER BY createdAt,id")
          .all(sourceId)
      : this.db.query<VideoQualification, []>("SELECT * FROM qualifications ORDER BY createdAt,id").all();
  }
  listCapabilities(): VideoCapability[] {
    return this.db.query<VideoCapability, []>("SELECT * FROM capabilities ORDER BY id").all();
  }

  /** Index actual exported source APIs without importing optional native providers. */
  async seedCapabilities(indexPath = Bun.fileURLToPath(new URL("./index.ts", import.meta.url))): Promise<number> {
    if (Bun.isStandaloneExecutable) {
      const { capabilities } = await import("bun-video:catalog-inventory");
      this.db.transaction(() => {
        for (const row of capabilities)
          this.db
            .query(
              "INSERT INTO capabilities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET family=excluded.family,exportName=excluded.exportName,sourceRef=excluded.sourceRef",
            )
            .run(row.id, row.family, row.exportName, row.sourceRef, row.status);
      })();
      return capabilities.length;
    }
    const index = await Bun.file(indexPath).text();
    const entries: VideoCapability[] = [];
    for (const match of index.matchAll(/export\s+(?:\*|\{([^}]+)\})\s+from\s+["']\.\/([^"']+)["']/g)) {
      const family = match[2]!;
      let names: string[];
      if (match[1])
        names = match[1]
          .split(",")
          .map(name =>
            name
              .trim()
              .split(/\s+as\s+/)
              .pop()!
              .replace(/^type\s+/, ""),
          )
          .filter(Boolean);
      else {
        const base = new URL(`./${family}.ts`, Bun.pathToFileURL(indexPath));
        const file = (await Bun.file(base).exists())
          ? Bun.file(base)
          : Bun.file(new URL(`./${family}.tsx`, Bun.pathToFileURL(indexPath)));
        const source = await file.text();
        names = [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|enum)\s+(\w+)/g)].map(
          item => item[1]!,
        );
      }
      for (const name of names)
        entries.push({
          id: `${family}:${name}`,
          family,
          exportName: name,
          sourceRef: `src/${family}`,
          status: "not_tested",
        });
    }
    const packageRoot = resolve(dirname(indexPath), "..");
    const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as { exports: Record<string, string> };
    const scanner = new Bun.Transpiler({ loader: "tsx" });
    for (const [subpath, ownerPath] of Object.entries(manifest.exports)) {
      if (subpath === "." || typeof ownerPath !== "string") continue;
      const absolute = resolve(packageRoot, ownerPath);
      const source = await Bun.file(absolute).text();
      const family = subpath.slice(2).replaceAll("/", "-");
      for (const name of scanner.scan(source).exports) {
        entries.push({
          id: `${family}:${name}`,
          family,
          exportName: name,
          sourceRef: relative(packageRoot, absolute).replaceAll("\\", "/"),
          status: "not_tested",
        });
      }
    }
    this.db.transaction(() => {
      for (const row of entries)
        this.db
          .query(
            "INSERT INTO capabilities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET family=excluded.family,exportName=excluded.exportName,sourceRef=excluded.sourceRef",
          )
          .run(row.id, row.family, row.exportName, row.sourceRef, row.status);
    })();
    return new Set(entries.map(entry => entry.id)).size;
  }

  /** Read the vendored extractor registry; registry membership is never a playback success. */
  async importYtDlpProviders(
    registryPath = Bun.fileURLToPath(new URL("../yt-dlp/yt_dlp/extractor/_extractors.py", import.meta.url)),
  ): Promise<number> {
    if (Bun.isStandaloneExecutable) {
      const { providers } = await import("bun-video:catalog-inventory");
      this.db.transaction(() => {
        for (const provider of providers) this.registerProvider(provider);
      })();
      return providers.length;
    }
    const text = await Bun.file(registryPath).text();
    const providers: { id: string; name: string; family: string; sourceRef: string }[] = [];
    for (const block of text.matchAll(/from\s+\.([\w.]+)\s+import\s+(?:\(([^)]+)\)|([^\r\n]+))/g)) {
      for (const name of (block[2] ?? block[3] ?? "").match(/\b\w+IE\b/g) ?? [])
        providers.push({
          id: `yt-dlp:${name}`,
          name,
          family: "yt-dlp",
          sourceRef: `yt_dlp/extractor/${block[1]!.replaceAll(".", "/")}.py`,
        });
    }
    this.db.transaction(() => {
      for (const provider of providers) this.registerProvider(provider);
    })();
    return providers.length;
  }
}
