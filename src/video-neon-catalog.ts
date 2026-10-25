import type {
  QualificationStatus,
  VideoArtifact,
  VideoJob,
  VideoJobStatus,
  VideoProvider,
  VideoQualification,
  VideoSource,
} from "./video-catalog";
import { join } from "node:path";
import type { NormalizedCapturedRequest } from "./video-capture";
import type { VideoDatasetQueryResult, VideoDatasetTable } from "./video-dataset";

type Row = Record<string, unknown>;

function parseJob(row: Row | undefined): VideoJob | null {
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(String(row.config)),
    result: row.result === null ? null : JSON.parse(String(row.result)),
  } as unknown as VideoJob;
}

/** PostgreSQL-backed private catalog. The supplied direct Bun.SQL connection belongs to this instance. */
export class NeonVideoCatalog {
  readonly #sql: Bun.SQL;

  private constructor(sql: Bun.SQL) {
    this.#sql = sql;
  }

  static async open(sql: Bun.SQL): Promise<NeonVideoCatalog> {
    const rows = await sql.unsafe<{ name: string }[]>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'bun_video'",
    );
    const names = new Set(rows.map(row => row.name));
    for (const name of [
      "providers",
      "capabilities",
      "sources",
      "jobs",
      "artifacts",
      "frames",
      "qualifications",
      "capture_entries",
      "captured_resources",
      "schema_migrations",
      "video_site_exports",
    ])
      if (!names.has(name)) throw new Error(`Neon video catalog schema is incomplete: ${name}`);
    return new NeonVideoCatalog(sql);
  }

  async transaction<T>(callback: (catalog: NeonVideoCatalog) => Promise<T>): Promise<T> {
    return this.#sql.begin(async tx => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('bun_video_catalog'))");
      return callback(new NeonVideoCatalog(tx as Bun.SQL));
    });
  }

  async selectPublicDataset(plan: {
    table: VideoDatasetTable;
    columns: string[];
    values: (string | number | null)[];
    conditions: string[];
    limit: number;
    offset: number;
  }): Promise<VideoDatasetQueryResult> {
    const clause = plan.conditions.length ? ` WHERE ${plan.conditions.join(" AND ")}` : "";
    let parameter = 0;
    const boundClause = clause.replaceAll("?", () => `$${++parameter}`);
    const rows = await this.#sql.unsafe<{ total: number }[]>(
      `SELECT COUNT(*)::integer AS total FROM bun_video."${plan.table}"${boundClause}`,
      plan.values,
    );
    const data = await this.#sql.unsafe<Record<string, unknown>[]>(
      `SELECT ${plan.columns.map(column => `"${column}"`).join(",")} FROM bun_video."${plan.table}"${boundClause} ORDER BY "id" LIMIT $${parameter + 1} OFFSET $${parameter + 2}`,
      [...plan.values, plan.limit, plan.offset],
    );
    return {
      table: plan.table,
      columns: plan.columns,
      rows: data,
      total: rows[0]?.total ?? 0,
      limit: plan.limit,
      offset: plan.offset,
    };
  }

  async listDocumentResources(sourceId?: string): Promise<
    {
      sourceId: string;
      entryIndex: number;
      kind: string;
      bodyRef: string;
      bytes: number;
      privateRef: string;
    }[]
  > {
    return this.#sql.unsafe(
      'SELECT r."sourceId",r."entryIndex",r."kind",r."bodyRef",r."bytes",s."privateRef" FROM bun_video.captured_resources r JOIN bun_video.sources s ON s."id"=r."sourceId" WHERE ($1::text IS NULL OR r."sourceId"=$1) ORDER BY r."sourceId",r."entryIndex"',
      [sourceId ?? null],
    );
  }

  async recordSiteExport(input: {
    id: string;
    format: string;
    path: string;
    documents: number;
    records: number;
    bytes: number;
    sha256: string;
  }): Promise<void> {
    await this.#sql.unsafe(
      'INSERT INTO bun_video.video_site_exports ("id","format","path","createdAt","documents","records","bytes","sha256") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [input.id, input.format, input.path, Date.now(), input.documents, input.records, input.bytes, input.sha256],
    );
  }

  async getSiteExport(id: string): Promise<{ format: string; path: string } | null> {
    const rows = await this.#sql.unsafe<{ format: string; path: string }[]>(
      'SELECT "format","path" FROM bun_video.video_site_exports WHERE "id"=$1',
      [id],
    );
    return rows[0] ?? null;
  }

  async registerProvider(
    input: Omit<VideoProvider, "status" | "sourceRef"> & Partial<Pick<VideoProvider, "status" | "sourceRef">>,
  ): Promise<VideoProvider> {
    const rows = await this.#sql.unsafe<VideoProvider[]>(
      'INSERT INTO bun_video.providers ("id","name","family","sourceRef","status") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name","family"=EXCLUDED."family","sourceRef"=EXCLUDED."sourceRef" RETURNING *',
      [input.id, input.name, input.family, input.sourceRef ?? null, input.status ?? "not_tested"],
    );
    return rows[0]!;
  }

  async listProviders(): Promise<VideoProvider[]> {
    return this.#sql.unsafe<VideoProvider[]>('SELECT * FROM bun_video.providers ORDER BY "id"');
  }

  async listQualifications(sourceId?: string): Promise<VideoQualification[]> {
    return sourceId
      ? this.#sql.unsafe<VideoQualification[]>(
          'SELECT * FROM bun_video.qualifications WHERE "sourceId"=$1 ORDER BY "createdAt","id"',
          [sourceId],
        )
      : this.#sql.unsafe<VideoQualification[]>('SELECT * FROM bun_video.qualifications ORDER BY "createdAt","id"');
  }

  async registerSource(input: {
    id?: string;
    url?: string;
    privateRef?: string;
    providerId?: string;
    kind?: "url" | "file" | "capture";
    title?: string;
  }): Promise<VideoSource> {
    if (!input.url && !input.privateRef) throw new TypeError("A public URL or private file reference is required");
    if (input.url) {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new TypeError("Store signed URLs and credential-bearing URLs in a protected file via privateRef");
    }
    const rows = await this.#sql.unsafe<VideoSource[]>(
      'INSERT INTO bun_video.sources ("id","url","privateRef","providerId","kind","title") VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [
        input.id ?? crypto.randomUUID(),
        input.url ?? null,
        input.privateRef ?? null,
        input.providerId ?? null,
        input.kind ?? (input.url ? "url" : "file"),
        input.title ?? null,
      ],
    );
    return rows[0]!;
  }

  async listSources(): Promise<VideoSource[]> {
    return this.#sql.unsafe<VideoSource[]>('SELECT * FROM bun_video.sources ORDER BY "id"');
  }

  async addJob(input: { id?: string; sourceId: string; engine: string; config?: unknown }): Promise<VideoJob> {
    const now = Date.now();
    const rows = await this.#sql.unsafe<Row[]>(
      'INSERT INTO bun_video.jobs ("id","sourceId","engine","status","workerId","config","error","result","createdAt","updatedAt") VALUES ($1,$2,$3,\'queued\',NULL,$4,NULL,NULL,$5,$5) RETURNING *',
      [input.id ?? crypto.randomUUID(), input.sourceId, input.engine, JSON.stringify(input.config ?? {}), now],
    );
    return parseJob(rows[0])!;
  }

  async getJob(id: string): Promise<VideoJob | null> {
    const rows = await this.#sql.unsafe<Row[]>('SELECT * FROM bun_video.jobs WHERE "id"=$1', [id]);
    return parseJob(rows[0]);
  }

  async updateJob(
    id: string,
    patch: { status: VideoJobStatus; workerId?: string; error?: string; result?: unknown },
  ): Promise<VideoJob> {
    const rows = await this.#sql.unsafe<Row[]>(
      'UPDATE bun_video.jobs SET "status"=$1,"workerId"=COALESCE($2,"workerId"),"error"=COALESCE($3,"error"),"result"=COALESCE($4,"result"),"updatedAt"=$5 WHERE "id"=$6 RETURNING *',
      [
        patch.status,
        patch.workerId ?? null,
        patch.error ?? null,
        patch.result === undefined ? null : JSON.stringify(patch.result),
        Date.now(),
        id,
      ],
    );
    const job = parseJob(rows[0]);
    if (!job) throw new Error(`Unknown video job: ${id}`);
    return job;
  }

  async listJobs(status?: VideoJobStatus): Promise<VideoJob[]> {
    const rows = status
      ? await this.#sql.unsafe<Row[]>('SELECT * FROM bun_video.jobs WHERE "status"=$1 ORDER BY "createdAt","id"', [
          status,
        ])
      : await this.#sql.unsafe<Row[]>('SELECT * FROM bun_video.jobs ORDER BY "createdAt","id"');
    return rows.map(row => parseJob(row)!);
  }

  async recordArtifact(
    input: Omit<VideoArtifact, "id" | "sha256" | "metadata"> & { id?: string; sha256?: string; metadata?: unknown },
  ): Promise<VideoArtifact> {
    const rows = await this.#sql.unsafe<Row[]>(
      'INSERT INTO bun_video.artifacts ("id","jobId","kind","path","sha256","metadata") VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [
        input.id ?? crypto.randomUUID(),
        input.jobId,
        input.kind,
        input.path,
        input.sha256 ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return { ...rows[0], metadata: JSON.parse(String(rows[0]!.metadata)) } as unknown as VideoArtifact;
  }

  async listArtifacts(jobId?: string): Promise<VideoArtifact[]> {
    const rows = jobId
      ? await this.#sql.unsafe<Row[]>('SELECT * FROM bun_video.artifacts WHERE "jobId"=$1 ORDER BY "id"', [jobId])
      : await this.#sql.unsafe<Row[]>('SELECT * FROM bun_video.artifacts ORDER BY "id"');
    return rows.map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) }) as unknown as VideoArtifact);
  }

  async recordFrame(input: {
    jobId: string;
    frame: number;
    artifactId: string;
    timestampMs?: number;
  }): Promise<string> {
    const owner = await this.#sql.unsafe<Row[]>('SELECT "jobId" FROM bun_video.artifacts WHERE "id"=$1', [
      input.artifactId,
    ]);
    if (owner[0]?.jobId !== input.jobId) throw new TypeError("Frame artifact must belong to the same job");
    const id = crypto.randomUUID();
    await this.#sql.unsafe(
      'INSERT INTO bun_video.frames ("id","jobId","frame","artifactId","timestampMs") VALUES ($1,$2,$3,$4,$5)',
      [id, input.jobId, input.frame, input.artifactId, input.timestampMs ?? null],
    );
    return id;
  }

  async listFrames(jobId: string): Promise<{ frame: number; artifactId: string; timestampMs: number | null }[]> {
    const rows = await this.#sql.unsafe<Row[]>(
      'SELECT "frame","artifactId","timestampMs" FROM bun_video.frames WHERE "jobId"=$1 ORDER BY "frame"',
      [jobId],
    );
    return rows.map(row => ({
      frame: Number(row.frame),
      artifactId: String(row.artifactId),
      timestampMs: row.timestampMs === null ? null : Number(row.timestampMs),
    }));
  }

  async recordQualification(input: {
    sourceId?: string;
    providerId?: string;
    capabilityId?: string;
    status: QualificationStatus;
    evidenceRef?: string;
    detail?: string;
  }): Promise<void> {
    await this.#sql.unsafe(
      'INSERT INTO bun_video.qualifications ("id","sourceId","providerId","capabilityId","status","evidenceRef","detail","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        crypto.randomUUID(),
        input.sourceId ?? null,
        input.providerId ?? null,
        input.capabilityId ?? null,
        input.status,
        input.evidenceRef ?? null,
        input.detail ?? null,
        Date.now(),
      ],
    );
  }

  async recordCapture(input: {
    sourceId: string;
    captureIndexPath: string;
    directory: string;
    requests: readonly NormalizedCapturedRequest[];
  }): Promise<void> {
    await this.#sql.begin(async tx => {
      await tx.unsafe(
        'INSERT INTO bun_video.sources ("id","url","privateRef","providerId","kind","title") VALUES ($1,NULL,$2,NULL,\'capture\',\'Captured video network\')',
        [input.sourceId, input.captureIndexPath],
      );
      for (const row of input.requests) {
        const bodyRef = row.bodyFile ? join(input.directory, row.bodyFile) : null;
        await tx.unsafe(
          'INSERT INTO bun_video.capture_entries ("id","sourceId","entryIndex","method","host","mimeType","status","encodedBytes","bytes","bodyRef","manifestKind","encrypted","complete") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [
            `${input.sourceId}:${row.entryIndex}`,
            input.sourceId,
            row.entryIndex,
            row.request.method,
            new URL(row.request.url).hostname,
            row.response.mimeType,
            row.response.status,
            row.encodedBytes,
            row.bytes,
            bodyRef,
            row.manifestKind,
            Number(row.encrypted),
            Number(row.complete),
          ],
        );
        if (bodyRef)
          await tx.unsafe(
            'INSERT INTO bun_video.captured_resources ("id","sourceId","entryIndex","kind","bodyRef","bytes") VALUES ($1,$2,$3,$4,$5,$6)',
            [`${input.sourceId}:${row.entryIndex}`, input.sourceId, row.entryIndex, row.kind, bodyRef, row.bytes],
          );
      }
    });
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
