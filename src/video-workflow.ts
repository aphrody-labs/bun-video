import { join, dirname } from "node:path";
import { VideoCatalog, defaultVideoCatalogPath, type QualificationStatus } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";
import { openConfiguredVideoCatalog } from "./video-neon-runtime";
import { describeVideoAPIs, loadVideoAPI, type VideoAPIFamily } from "./video-api";
import { VideoWorkerPool, type VideoWorkerPoolOptions } from "./video-workers";
import type { VideoRenderTask } from "./video-worker-task";
import type { VideoPipelineOptions } from "./pipeline";
import type { ArchiveCaptureOptions } from "./archive-capture";
import type { VideoDatasetQuery } from "./video-dataset";
import type { VideoDataSiteOptions } from "./video-data-site";

/** Canonical application workflow; libraries keep their native implementation owners. */
export class UnifiedVideoPipeline {
  readonly catalog: VideoCatalog | NeonVideoCatalog;
  readonly workers: VideoWorkerPool;
  readonly #ownsCatalog: boolean;
  constructor(
    options: Omit<VideoWorkerPoolOptions, "catalog"> & {
      catalog?: VideoCatalog | NeonVideoCatalog;
      dbPath?: string;
      closeCatalog?: boolean;
    } = {},
  ) {
    this.#ownsCatalog = options.closeCatalog ?? !options.catalog;
    this.catalog = options.catalog ?? new VideoCatalog(options.dbPath);
    this.workers = new VideoWorkerPool({ ...options, catalog: this.catalog });
  }
  async initialize() {
    if (this.catalog instanceof NeonVideoCatalog) {
      const [capabilities, providers] = await Promise.all([
        this.catalog.selectPublicDataset({
          table: "capabilities",
          columns: ["id"],
          values: [],
          conditions: [],
          limit: 1,
          offset: 0,
        }),
        this.catalog.selectPublicDataset({
          table: "providers",
          columns: ["id"],
          values: [],
          conditions: [],
          limit: 1,
          offset: 0,
        }),
      ]);
      return {
        database: "bun_video",
        capabilities: capabilities.total,
        providers: providers.total,
        apiFamilies: describeVideoAPIs().length,
        qualification: "catalog-only" as const,
      };
    }
    const capabilities = await this.catalog.seedCapabilities();
    const providers = await this.catalog.importYtDlpProviders();
    return {
      database: this.catalog.db.filename,
      capabilities,
      providers,
      apiFamilies: describeVideoAPIs().length,
      qualification: "catalog-only" as const,
    };
  }
  apis() {
    return describeVideoAPIs();
  }
  api(family: VideoAPIFamily) {
    return loadVideoAPI(family);
  }
  render(task: VideoRenderTask, signal?: AbortSignal) {
    return this.workers.submit(task, signal);
  }
  async publish(options: Parameters<typeof import("./video-publish").publishBunVideoExports>[1]) {
    const { publishBunVideoExports } = await import("./video-publish");
    return publishBunVideoExports(this.catalog, options);
  }
  async native(options: VideoPipelineOptions) {
    const { openVideoPipeline } = await import("./pipeline");
    return openVideoPipeline(options);
  }
  /** Watch a video (frames and transcript) and record the evidence as a catalog job. */
  async watch(options: import("./watch").WatchOptions) {
    const { watchAndRecord } = await import("./video-watch");
    return watchAndRecord(this.catalog, options);
  }
  /** Frames and transcript of an earlier watch job, read back from the catalog. */
  async watchEvidence(jobId: string) {
    const { watchEvidence } = await import("./video-watch");
    return watchEvidence(this.catalog, jobId);
  }
  /** Compare a rendered video with a watch job's reference frames, natively, and record the qualification. */
  async verifyRender(options: import("./video-verify").VerifyRenderOptions) {
    const { verifyRenderAgainstWatch } = await import("./video-verify");
    return verifyRenderAgainstWatch(this.catalog, options);
  }
  media(job: import("./media-workflow").MediaJob) {
    return import("./media-workflow").then(({ executeMediaJob }) => executeMediaJob(job));
  }
  async capture(url = "https://www.crunchyroll.com/", options: { check?: boolean; endpoint?: string } = {}) {
    const { runNetworkWindow } = await import("../src/apps/network-window");
    return runNetworkWindow(url, options);
  }
  async importCapture(path: string) {
    const { importCapturedVideoNetwork } = await import("./video-capture");
    return importCapturedVideoNetwork(path, { catalog: this.catalog });
  }
  async archiveCapture(options: ArchiveCaptureOptions = {}) {
    const { captureArchiveHTTP } = await import("./archive-capture");
    return captureArchiveHTTP(options);
  }
  async inspectCookies(privatePath: string, url = "https://www.crunchyroll.com/") {
    const { loadVideoCookies, describeVideoCookies } = await import("./video-cookies");
    const cookies = await loadVideoCookies(privatePath);
    const summary = describeVideoCookies(cookies, url);
    const source = await this.catalog.registerSource({
      privateRef: privatePath,
      kind: "capture",
      title: "Private Crunchyroll cookie input",
    });
    return { ...summary, sourceId: source.id };
  }
  async probeCookies(privatePath: string, options: { url?: string; signal?: AbortSignal } = {}) {
    const { probeCrunchyrollCookies } = await import("./video-cookies");
    return probeCrunchyrollCookies(privatePath, options);
  }
  async dataSite(options: Omit<VideoDataSiteOptions, "catalog" | "dbPath"> = {}) {
    const { createVideoDataSite } = await import("./video-data-site");
    return createVideoDataSite({ ...options, catalog: this.catalog });
  }
  async queryDataset(request: VideoDatasetQuery) {
    const { queryVideoDataset } = await import("./video-dataset");
    return this.catalog instanceof NeonVideoCatalog
      ? queryVideoDataset(this.catalog, request)
      : queryVideoDataset(this.catalog, request);
  }
  async exportDataset(options: Parameters<typeof import("./video-dataset").exportVideoDataset>[1]) {
    const { exportVideoDataset } = await import("./video-dataset");
    return exportVideoDataset(this.catalog, options);
  }
  async qualifySites(urls: readonly string[], options: { endpoint?: string } = {}) {
    if (!urls.length || urls.length > 100)
      throw new RangeError("Select 1..100 real site URLs for a qualification batch");
    const batch = crypto.randomUUID();
    const directory = join(dirname(defaultVideoCatalogPath()), "site-checks", batch);
    await Bun.write(join(directory, "sources.json"), JSON.stringify(urls));
    const results: { sourceId: string; status: QualificationStatus; evidenceRef: string; phase: "browser-network" }[] =
      [];
    for (let index = 0; index < urls.length; index++) {
      const url = new URL(urls[index]!);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        /(^|\.)(example\.(com|org|net)|localhost)$/.test(url.hostname)
      )
        throw new TypeError("Real HTTP(S) site URL without credentials required");
      const source = await this.catalog.registerSource({
        privateRef: join(directory, "sources.json"),
        kind: "url",
        title: `Site ${index + 1}`,
      });
      const evidenceRef = join(directory, `${index}.json`);
      let status: QualificationStatus = "passed";
      try {
        const result = await this.capture(url.href, { check: true, ...options });
        await Bun.write(
          evidenceRef,
          JSON.stringify({ phase: "browser-network", result, playbackQualified: false, renderQualified: false }),
        );
      } catch (error) {
        status = "blocked";
        await Bun.write(
          evidenceRef,
          JSON.stringify({
            phase: "browser-network",
            error: String(error),
            playbackQualified: false,
            renderQualified: false,
          }),
        );
      }
      await this.catalog.recordQualification({
        sourceId: source.id,
        status,
        evidenceRef,
        detail: "Browser network inspection only; media playback and render are separate gates",
      });
      results.push({ sourceId: source.id, status, evidenceRef, phase: "browser-network" });
    }
    return results;
  }
  async close() {
    await this.workers.close();
    if (this.#ownsCatalog) await this.catalog.close();
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

export function createUnifiedVideoPipeline(
  options: Omit<VideoWorkerPoolOptions, "catalog"> & {
    catalog?: VideoCatalog | NeonVideoCatalog;
    dbPath?: string;
    closeCatalog?: boolean;
  } = {},
) {
  return new UnifiedVideoPipeline(options);
}

export async function openConfiguredUnifiedVideoPipeline(
  options: Omit<VideoWorkerPoolOptions, "catalog"> & { dbPath?: string } = {},
) {
  const catalog = await openConfiguredVideoCatalog({ sqlitePath: options.dbPath });
  return new UnifiedVideoPipeline({ ...options, catalog, closeCatalog: true });
}
