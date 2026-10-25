import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadYtDlp,
  listYtDlpExtractors,
  normalizeYtDlpOptions,
  parseYtDlpOptions,
  runYtDlp,
  runYtDlpCli,
  ytDlpRuntimeInfo,
} from "../src/ytdlp";

describe("yt-dlp Bun Python bridge", () => {
  test("normalizes aliases without dropping upstream options", () => {
    expect(
      normalizeYtDlpOptions({
        output: "private/video.%(ext)s",
        noWarnings: true,
        skipDownload: true,
        httpHeaders: { Origin: "https://www.crunchyroll.com" },
        custom_upstream_flag: 42,
      }),
    ).toEqual({
      outtmpl: "private/video.%(ext)s",
      no_warnings: true,
      skip_download: true,
      http_headers: { Origin: "https://www.crunchyroll.com" },
      custom_upstream_flag: 42,
    });
    expect(
      normalizeYtDlpOptions({ noWarnings: true, no_warnings: false, output: "alias", outtmpl: "canonical" }),
    ).toEqual({ no_warnings: false, outtmpl: "canonical" });
  });
  test("rejects credential URLs and cancellation before touching Python", async () => {
    await expect(runYtDlp({ url: "https://user:password@www.crunchyroll.com/watch/test" })).rejects.toThrow(
      "without credentials",
    );
    await expect(
      runYtDlp({ url: "https://www.crunchyroll.com/watch/test", signal: AbortSignal.abort(new Error("cancelled")) }),
    ).rejects.toThrow("cancelled");
    await expect(runYtDlpCli(["--format\0"])).rejects.toThrow("NUL");
    await expect(runYtDlp({ url: "https://example.invalid/a.mp4", maxBytes: 0 })).rejects.toThrow("maxBytes");
    await expect(runYtDlp({ url: "https://example.invalid/a.mp4", maxDurationSeconds: 86_401 })).rejects.toThrow(
      "maxDurationSeconds",
    );
    await expect(
      runYtDlp({ url: "https://example.invalid/a.mp4", options: { cookieFile: "C:/private/cookies.txt" } }),
    ).rejects.toThrow("protected privateDirectory");
    await expect(
      runYtDlp({ url: "https://example.invalid/a.mp4", options: { cookiesFromBrowser: ["chrome"] } }),
    ).rejects.toThrow("browser cookies are disabled");
  });
  test("downloads a local generic HTTP media fixture with bounded progress and a private result", async () => {
    const runtime = await ytDlpRuntimeInfo();
    if (!runtime.available) return;
    const source = Bun.file(new URL("../hyperframes/cli/src/commands/__fixtures__/silent.mp4", import.meta.url));
    const dir = await mkdtemp(join(tmpdir(), "bun-ytdlp-local-"));
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/fixture.mp4")
          return new Response(source, { headers: { "content-type": "video/mp4" } });
        return new Response("not found", { status: 404 });
      },
    });
    const events: Array<{ downloadedBytes: number; filename: string | null }> = [];
    const output = join(dir, "fixture.mp4");
    try {
      const result = await downloadYtDlp(
        `${server.url}fixture.mp4?token=fixture-secret`,
        output,
        { format: "best" },
        {
          maxBytes: 8 * 1024 * 1024,
          maxDurationSeconds: 30,
          onProgress(progress) {
            events.push({ downloadedBytes: progress.downloadedBytes, filename: progress.filename });
          },
        },
      );
      expect(result.localPath).toBe(output);
      expect((await Bun.file(output).bytes()).byteLength).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(events.every(event => !event.filename?.includes(dir))).toBe(true);
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("native session reports reality and exposes the full installed extractor registry", async () => {
    const info = await ytDlpRuntimeInfo();
    expect(info.bunRevision).toBe(Bun.revision);
    if (Bun.env.BUN_PYTHON_HOST_LIBRARY || Bun.env.BUV_PYTHON_HOST_LIBRARY) expect(info.available).toBe(true);
    if (!info.available) {
      expect(info.error).toBeTruthy();
      return;
    }
    expect(info.pythonVersion).toMatch(/3\./);
    expect(info.ytDlpVersion).toMatch(/^\d{4}\./);
    const extractors = await listYtDlpExtractors();
    expect(extractors.length).toBeGreaterThan(1000);
    expect(extractors.some(row => row.name === "generic")).toBe(true);
    const parsed = await parseYtDlpOptions([
      "--skip-download",
      "--format",
      "best",
      "https://www.crunchyroll.com/watch/test",
    ]);
    expect(parsed.urls).toEqual(["https://www.crunchyroll.com/watch/test"]);
    expect(parsed.options.skip_download).toBe(true);
    const cli = await runYtDlpCli(["--version"]);
    expect(cli.exitCode).toBe(0);
    if (typeof cli.stdout !== "string") throw new Error("yt-dlp did not capture standard output");
    if (typeof info.ytDlpVersion !== "string") throw new Error("yt-dlp did not report its installed version");
    expect(cli.stdout.trim()).toBe(info.ytDlpVersion);
  });
});
