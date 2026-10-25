import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Card,
  Input,
  ProgressBar,
  Slider,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@aphrody/m3-primitives";
import { applyDynamicColor, schemeFromSeed } from "@aphrody/m3-tokens/dynamic-color";
import { applyVideoFrameTheme, frameThemeFromRGBA, type VideoFrameTheme } from "../../frame-theme";
import { assetURL, datasetPreview, frameFile, timestamp, type EpisodeManifest } from "./manifest";
import type { FrameMetrics } from "./frame-metrics";
import "./style.css";

const number = new Intl.NumberFormat("fr-FR");
function size(bytes: number) {
  return `${number.format(Math.round(bytes / 1_000_000))} Mo`;
}
function chapterTitle(title: string) {
  return (
    (
      {
        "Chapter 1": "Ouverture",
        Intro: "Générique d’ouverture",
        "Chapter 2": "L’épisode",
        Credits: "Générique de fin",
      } as Record<string, string>
    )[title] ?? title
  );
}
function Download({ file, children }: { file: string; children: React.ReactNode }) {
  return (
    <Button variant="outlined" className="download" href={`${assetURL(file)}?download`} download>
      {children}
      <span aria-hidden="true">↓</span>
    </Button>
  );
}

function App() {
  const [manifest, setManifest] = useState<EpisodeManifest>();
  const [error, setError] = useState("");
  const [themeError, setThemeError] = useState("");
  const [gpuMetrics, setGpuMetrics] = useState<FrameMetrics>();
  const [gpuStatus, setGpuStatus] = useState("Analyse GPU en préparation");
  const [current, setCurrent] = useState(0);
  const [frame, setFrame] = useState(1);
  const [frameMissing, setFrameMissing] = useState(false);
  const [tab, setTab] = useState<"frames" | "moments" | "characters" | "vectors">("frames");
  const [volumePage, setVolumePage] = useState(0);
  const [vectorPage, setVectorPage] = useState(0);
  const [dataset, setDataset] = useState<{
    status?: string;
    captions?: {
      french: number;
      japanese: number;
      japaneseTextSource?: string;
      japaneseProof?: { status: string };
      japaneseAsrProof?: { status: string; timestampGranularitySeconds?: number; wordTimestampsVerified?: boolean };
    };
    splits?: { train: number; validation: number; test: number };
    japaneseLexiconConfirmedNames?: number;
    modelTrainingPerformed?: boolean;
  }>();
  const [datasetError, setDatasetError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const requestedFrame = useRef<{ index: number; time: number } | undefined>(undefined);
  const themeCanvas = useRef<HTMLCanvasElement | null>(null);
  const [theme, setTheme] = useState<{ seed: string; time: number; source: "video" | "poster" }>();
  async function load() {
    try {
      const response = await fetch("api/manifest");
      if (!response.ok) throw new Error(await response.text());
      setManifest(await response.json());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setFrameMissing(false);
  }, [frame, manifest?.frames?.count]);
  useEffect(() => {
    const file = manifest?.dataset?.manifest;
    if (!file) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(assetURL(file), { signal: controller.signal });
        if (!response.ok) throw new Error(`Manifeste dataset : HTTP ${response.status}`);
        setDataset(await response.json());
        setDatasetError("");
      } catch (error) {
        if (!controller.signal.aborted) setDatasetError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => controller.abort();
  }, [manifest?.dataset?.manifest]);
  useEffect(() => {
    const player = video.current;
    if (!manifest || !player) return;
    const canvas = (themeCanvas.current ??= document.createElement("canvas"));
    let lastSample = -Infinity;
    let cancelled = false;
    let frameCallback: number | undefined;
    let gpuBusy = false,
      gpuQueued = false,
      lastGpu = -Infinity;
    const gpuController = new AbortController();
    function publish(result: VideoFrameTheme, time: number, source: "video" | "poster") {
      if (cancelled) return;
      const root = document.documentElement;
      root.dataset.frameThemeSeed = result.seed;
      root.dataset.frameThemeTime = String(time);
      root.dataset.frameThemeSource = source;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", result.roles["--md-sys-color-surface"] ?? result.seed);
      setTheme({ seed: result.seed, time, source });
      setThemeError("");
    }
    async function sampleGpu(force = false) {
      if (cancelled || player!.seeking || player!.readyState < 2) return;
      if (gpuBusy) {
        gpuQueued ||= force;
        return;
      }
      if (!force && performance.now() - lastGpu < 3000) return;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || canvas.width < 4 || canvas.height < 4) return;
      const sampledTime = player!.currentTime;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      gpuBusy = true;
      lastGpu = performance.now();
      try {
        const response = await fetch(`api/frame-analysis?width=${canvas.width}&height=${canvas.height}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pixels.data,
          signal: AbortSignal.any([gpuController.signal, AbortSignal.timeout(6000)]),
        });
        if (!response.ok) throw new Error("GPU indisponible");
        const metrics: FrameMetrics = await response.json();
        if (cancelled || player!.seeking || Math.abs(player!.currentTime - sampledTime) > 0.5) return;
        if (metrics.computation !== "WGSL" || !metrics.dominantColor || !metrics.samples) return;
        const seed = `#${metrics.dominantColor
          .map(value =>
            Math.round(Math.max(0, Math.min(255, value)))
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`;
        applyDynamicColor(seed, { dark: true, variant: "content" });
        publish(
          { seed, roles: schemeFromSeed(seed, { dark: true, variant: "content" }), sampledPixels: metrics.samples },
          sampledTime,
          "video",
        );
        document.documentElement.dataset.frameAnalysisComputation = "WGSL";
        document.documentElement.dataset.frameAnalysisTime = String(sampledTime);
        document.documentElement.dataset.frameAnalysisAdapter = JSON.stringify(metrics.adapter);
        document.documentElement.dataset.frameAnalysisSamples = String(metrics.samples);
        setGpuMetrics(metrics);
        setGpuStatus(`Dominante et détail calculés sur GPU · ${Math.round(metrics.elapsedMs)} ms`);
      } catch {
        if (!cancelled) setGpuStatus("GPU indisponible · thème calculé depuis les pixels locaux");
      } finally {
        gpuBusy = false;
        if (gpuQueued) {
          gpuQueued = false;
          void sampleGpu(true);
        }
      }
    }
    function sample(force = false) {
      if (cancelled || player!.seeking || (!force && performance.now() - lastSample < 1000)) return;
      try {
        const result = applyVideoFrameTheme(player!, { canvas, maxDimension: 64, dark: true, variant: "content" });
        if (result) {
          lastSample = performance.now();
          publish(result, player!.currentTime, "video");
          void sampleGpu(force);
        }
      } catch (failure) {
        setThemeError(
          `Thème de l’image indisponible : ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    const update = () => sample(false);
    const immediate = () => sample(true);
    const presented = () => {
      if (frameCallback !== undefined) player.cancelVideoFrameCallback(frameCallback);
      frameCallback = player.requestVideoFrameCallback(() => {
        frameCallback = undefined;
        sample(true);
      });
    };
    player.addEventListener("seeking", presented);
    player.addEventListener("timeupdate", update);
    for (const event of ["loadeddata", "seeked", "pause"]) player.addEventListener(event, immediate);
    const poster = manifest.poster ?? manifest.storyboard?.find(item => item.time > 90)?.file;
    const image = new Image();
    if (poster) {
      image.onload = () => {
        if (cancelled || player.readyState >= 2) return;
        canvas.width = 64;
        canvas.height = Math.max(1, Math.round((64 * image.naturalHeight) / image.naturalWidth));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = frameThemeFromRGBA(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          { dark: true, variant: "content" },
        );
        applyDynamicColor(result.seed, { dark: true, variant: "content" });
        publish(result, 0, "poster");
      };
      image.src = assetURL(poster);
    }
    sample(true);
    return () => {
      cancelled = true;
      gpuController.abort();
      image.onload = null;
      if (frameCallback !== undefined) player.cancelVideoFrameCallback(frameCallback);
      player.removeEventListener("seeking", presented);
      player.removeEventListener("timeupdate", update);
      for (const event of ["loadeddata", "seeked", "pause"]) player.removeEventListener(event, immediate);
    };
  }, [manifest]);
  if (!manifest)
    return (
      <main className="loading">
        <div className="brand-mark">◈</div>
        <h1>Atelier épisode</h1>
        <p role="status">{error || "Chargement de l’épisode…"}</p>
        {error && (
          <Button variant="text" onClick={() => void load()}>
            Actualiser
          </Button>
        )}
      </main>
    );
  const m = manifest;
  const fps = m.fps.numerator / m.fps.denominator;
  const storyboard = m.storyboard ?? [];
  const poster = m.poster ?? storyboard.find(item => item.time > 90)?.file ?? storyboard[0]?.file;
  const selectedFrame = frameFile(m, frame);
  const activeChapter = [...(m.chapters ?? [])].reverse().find(chapter => chapter.start <= current);
  function visibleFrame(time: number) {
    const requested = requestedFrame.current;
    if (requested && Math.abs(time - requested.time) < 1 / (fps * 4)) return requested.index;
    return Math.min(m.frameCount, Math.floor(time * fps) + 1);
  }
  function seek(time: number, exactFrame?: number) {
    const next = Math.max(0, Math.min(m.durationSeconds, time));
    requestedFrame.current = exactFrame === undefined ? undefined : { index: exactFrame, time: next };
    if (video.current) video.current.currentTime = next;
    setCurrent(next);
    setFrame(visibleFrame(next));
  }
  function step(nextFrame: number) {
    const next = Math.max(1, Math.min(m.frameCount, nextFrame));
    video.current?.pause();
    seek((next - 1) / fps, next);
  }
  const compression = m.compression;
  const japaneseASR = dataset?.captions?.japaneseTextSource?.startsWith("native-ASR") ?? false;
  const japaneseASRQualified = dataset?.captions?.japaneseAsrProof?.status === "complete";
  const vectors = [...(m.pixelSVG?.entries ?? [])].sort(
    (a, b) => Number(b.role === "portrait-crop-svg") - Number(a.role === "portrait-crop-svg"),
  );
  const percent = m.frameCount ? Math.min(100, Math.round(((m.frames?.count ?? 0) / m.frameCount) * 100)) : 0;
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Bun Video, accueil">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span>
            Bun Video <small>Atelier épisode</small>
          </span>
        </a>
        <nav aria-label="Navigation">
          <a href="#player">Épisode</a>
          <a href="#explore">Explorer</a>
          <a href="#files">Fichiers</a>
        </nav>
        <Button variant="text" className="refresh" onClick={() => void load()} aria-label="Actualiser les ressources">
          ↻
        </Button>
      </header>
      <main>
        <section className="episode-head">
          <div>
            <p className="series">Dragon Ball Super</p>
            <h1>{m.title.replace(/^Épisode\s*1\s*[—–:-]?\s*|^.*S01E01\s*/i, "")}</h1>
          </div>
          <div className="episode-meta">
            <span>Épisode 01</span>
            <strong>{timestamp(m.durationSeconds)}</strong>
            <span>
              {m.width} × {m.height}
            </span>
          </div>
        </section>
        <Card variant="elevated" className="screen-layout" id="player" role="region" aria-label="Lecteur de l’épisode">
          <div className="screen">
            <video
              ref={video}
              controls
              preload="metadata"
              poster={poster ? assetURL(poster) : undefined}
              onTimeUpdate={event => {
                const time = event.currentTarget.currentTime;
                setCurrent(time);
                if (event.currentTarget.paused) setFrame(visibleFrame(time));
              }}
              onPause={event => setFrame(visibleFrame(event.currentTarget.currentTime))}
              onPlay={() => {
                requestedFrame.current = undefined;
              }}
            >
              <source src={assetURL(m.source.file)} type="video/mp4" />
              {(m.subtitles ?? [])
                .filter(track => track.file.endsWith(".vtt"))
                .map(track => (
                  <track
                    key={track.file}
                    kind="subtitles"
                    src={assetURL(track.file)}
                    srcLang={track.language}
                    label={track.label}
                  />
                ))}
            </video>
            <div className="player-caption">
              <span>{activeChapter ? chapterTitle(activeChapter.title) : "Épisode"}</span>
              <span>
                {timestamp(current)} / {timestamp(m.durationSeconds)}
              </span>
            </div>
          </div>
          <aside className="chapter-panel">
            <h2>Dans cet épisode</h2>
            <div className="chapters">
              {(m.chapters ?? []).map((chapter, index) => (
                <Button
                  variant={activeChapter === chapter ? "tonal" : "text"}
                  key={`${chapter.start}-${index}`}
                  className={activeChapter === chapter ? "chapter active" : "chapter"}
                  onClick={() => seek(chapter.start)}
                >
                  <span className="chapter-number">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    {chapterTitle(chapter.title)}
                    <small>
                      {timestamp(chapter.start)}
                      {chapter.end ? ` – ${timestamp(chapter.end)}` : ""}
                    </small>
                  </span>
                  <span aria-hidden="true">▷</span>
                </Button>
              ))}
            </div>
            <div className="source-note">
              <span className="source-dot" />
              Source locale
              <p>
                {m.video?.codec ?? "Vidéo"} · {number.format(Math.round(fps * 1000) / 1000)} images/s
                <br />
                {m.audio?.language === "jpn" ? "Audio japonais" : (m.audio?.language ?? "Audio original")}
                {m.audio?.channels === 2 ? ", stéréo" : ""}
              </p>
              <p className="theme-source" role="status">
                {theme
                  ? `Thème de ${theme.source === "poster" ? "l’affiche" : `l’image à ${timestamp(theme.time)}`} · ${theme.seed}`
                  : "Thème de l’image en préparation"}
              </p>
              <p className="theme-source" role="status">
                {gpuStatus}
                {gpuMetrics && (
                  <>
                    <br />
                    Détail : {number.format(Math.round(gpuMetrics.detailScore))} · {number.format(gpuMetrics.samples)}{" "}
                    pixels analysés
                  </>
                )}
              </p>
            </div>
            <Download file={m.source.file}>
              Vidéo originale <small>{size(m.source.bytes)}</small>
            </Download>
          </aside>
        </Card>
        <section className="explore" id="explore">
          <div className="section-top">
            <h2>L’épisode, image par image</h2>
            <p>{number.format(m.frameCount)} images originales</p>
          </div>
          <TabsRoot value={tab} onValueChange={(value: string) => setTab(value as typeof tab)}>
            <TabsList className="tabs" aria-label="Ressources de l’épisode">
              {(
                [
                  ["frames", "Images"],
                  ["moments", "Moments en GIF"],
                  ["characters", "Personnages"],
                  ["vectors", "SVG source"],
                ] as const
              ).map(([key, label]) => (
                <TabsTrigger key={key} id={`tab-${key}`} value={key}>
                  {label}
                  {key === "moments" && <small>{m.highlights?.length ?? 0}</small>}
                  {key === "characters" && <small>{m.characters?.length ?? 0}</small>}
                  {key === "vectors" && <small>{m.pixelSVG?.entries.length ?? 0}</small>}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === "frames" && (
              <TabsContent id="panel-frames" value="frames">
                <div className="frame-workbench">
                  <figure className="frame-view">
                    {selectedFrame && !frameMissing ? (
                      <img
                        src={assetURL(selectedFrame)}
                        alt={`Image ${frame} à ${timestamp((frame - 1) / fps)}`}
                        onError={() => setFrameMissing(true)}
                      />
                    ) : (
                      <div className="frame-empty">
                        <span aria-hidden="true">◈</span>
                        <p>Image {number.format(frame)}</p>
                        <small>Cette image est en cours d’extraction.</small>
                      </div>
                    )}
                    <figcaption>
                      <span>Image {number.format(frame)}</span>
                      <span>{((frame - 1) / fps).toFixed(3)} s</span>
                    </figcaption>
                  </figure>
                  <div className="frame-tools">
                    <h3>Chaque détail compte.</h3>
                    <p>Parcourez les images à leur résolution originale, à la cadence de l’épisode.</p>
                    <label htmlFor="frame-index">Numéro de l’image</label>
                    <div className="frame-input">
                      <Button
                        variant="text"
                        onClick={() => step(frame - 1)}
                        disabled={frame <= 1}
                        aria-label="Image précédente"
                      >
                        ‹
                      </Button>
                      <Input
                        id="frame-index"
                        type="number"
                        min={1}
                        max={m.frameCount}
                        value={frame}
                        onChange={event => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value) && value >= 1) step(Math.floor(value));
                        }}
                      />
                      <Button
                        variant="text"
                        onClick={() => step(frame + 1)}
                        disabled={frame >= m.frameCount}
                        aria-label="Image suivante"
                      >
                        ›
                      </Button>
                    </div>
                    <Slider
                      className="frame-slider"
                      aria-label="Parcourir les images"
                      min={1}
                      max={m.frameCount}
                      value={[frame]}
                      onValueChange={(value: number[]) => step(value[0]!)}
                    />
                    <p className="extraction">
                      {number.format(m.frames?.count ?? 0)} / {number.format(m.frameCount)} images disponibles{" "}
                      <span>{percent} %</span>
                    </p>
                    <ProgressBar value={m.frames?.count ?? 0} total={m.frameCount} />
                    {selectedFrame && !frameMissing && (
                      <Download file={selectedFrame}>Télécharger cette image</Download>
                    )}
                  </div>
                </div>
                <div className="storyboard" aria-label="Aperçu des scènes">
                  {storyboard.map(item => (
                    <Button
                      variant="text"
                      key={item.file}
                      onClick={() => seek(item.time)}
                      aria-label={`Aller à ${timestamp(item.time)}`}
                    >
                      <img src={assetURL(item.file)} alt="" loading="lazy" />
                      <span>{timestamp(item.time)}</span>
                    </Button>
                  ))}
                </div>
              </TabsContent>
            )}
            {tab === "moments" && (
              <TabsContent id="panel-moments" value="moments" className="moments">
                {m.highlights?.length ? (
                  m.highlights.map(item => (
                    <Card variant="elevated" key={item.id}>
                      <img src={assetURL(item.file)} alt={item.title} loading="lazy" />
                      <div>
                        <h3>{item.title}</h3>
                        <Button variant="text" className="text-button" onClick={() => seek(item.start)}>
                          Voir à {timestamp(item.start)} · {item.duration} s
                        </Button>
                        <Download file={item.file}>Télécharger le GIF</Download>
                      </div>
                    </Card>
                  ))
                ) : (
                  <p className="empty">Les moments sélectionnés apparaîtront ici après leur extraction.</p>
                )}
              </TabsContent>
            )}
            {tab === "characters" && (
              <TabsContent id="panel-characters" value="characters" className="characters">
                <p className="resource-note">
                  Icônes stylisées dérivées. Les références fidèles aux pixels de l’anime sont dans « SVG source ».
                </p>
                {m.characters?.length ? (
                  m.characters.map(item => (
                    <Card variant="outlined" key={item.id}>
                      <div className="portrait">
                        <img src={assetURL(item.icon)} alt={`Icône de ${item.name}`} />
                      </div>
                      <h3>{item.name}</h3>
                      {item.description && <p>{item.description}</p>}
                      {typeof item.firstSeen === "number" && (
                        <Button variant="text" className="text-button" onClick={() => seek(item.firstSeen!)}>
                          Voir à {timestamp(item.firstSeen)}
                        </Button>
                      )}
                      <Download file={item.icon}>Icône SVG</Download>
                    </Card>
                  ))
                ) : (
                  <p className="empty">Les personnages apparaîtront ici après leur identification.</p>
                )}
              </TabsContent>
            )}
            {tab === "vectors" && (
              <TabsContent id="panel-vectors" value="vectors">
                <p className="resource-note">
                  Paths vectoriels exacts de la référence PNG redimensionnée. Les portraits indiquent leur recadrage ;
                  les autres ressources montrent la frame complète.
                </p>
                <div className="reference-vectors">
                  {vectors.slice(vectorPage * 6, vectorPage * 6 + 6).map(item => (
                    <Card variant="outlined" key={item.id}>
                      <img src={assetURL(item.svg)} alt={item.title} loading="lazy" />
                      <div>
                        <h3>{item.title}</h3>
                        <p>
                          {item.width} × {item.height} ·{" "}
                          {item.role === "portrait-crop-svg" ? "Portrait recadré" : "Frame de référence"}
                        </p>
                        <p>
                          {item.verification?.exact === true
                            ? "Rendu RGBA exact, zéro pixel différent"
                            : "Vérification RGBA en cours"}
                        </p>
                        <div className="asset-actions">
                          <Download file={item.svg}>SVG</Download>
                          <Download file={item.referencePNG}>PNG de référence</Download>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
                {vectors.length > 6 && (
                  <div className="asset-pagination">
                    <Button
                      variant="outlined"
                      disabled={vectorPage === 0}
                      onClick={() => setVectorPage(value => value - 1)}
                    >
                      Précédent
                    </Button>
                    <span>
                      {vectorPage + 1} / {Math.ceil(vectors.length / 6)}
                    </span>
                    <Button
                      variant="outlined"
                      disabled={(vectorPage + 1) * 6 >= vectors.length}
                      onClick={() => setVectorPage(value => value + 1)}
                    >
                      Suivant
                    </Button>
                  </div>
                )}
                {!vectors.length && <p className="empty">Les références vectorielles sont en cours de création.</p>}
              </TabsContent>
            )}
          </TabsRoot>
        </section>
        <section className="files" id="files">
          <div>
            <h2>Les fichiers de l’épisode</h2>
            <p>La source et ses ressources, réunies au même endroit.</p>
            <dl>
              <div>
                <dt>Image</dt>
                <dd>
                  {m.width} × {m.height} · {m.video?.colorSpace ?? "Espace couleur non renseigné"}
                </dd>
              </div>
              <div>
                <dt>Cadence</dt>
                <dd>
                  {m.fps.numerator}/{m.fps.denominator} images/s
                </dd>
              </div>
              <div>
                <dt>Extraction</dt>
                <dd>{m.frames?.format ?? "En préparation"}</dd>
              </div>
            </dl>
          </div>
          <div className="file-list">
            {compression && (
              <article>
                <div>
                  <h3>Compression {compression.codec}</h3>
                  <p>
                    {compression.verified
                      ? compression.lossless
                        ? "Sans perte, intégrité vérifiée"
                        : "Intégrité vérifiée"
                      : "Vérification en cours"}
                    {compression.bytes > 0 && ` · ${size(compression.bytes)}`}
                  </p>
                </div>
                {compression.bytes > 0 && <Download file={compression.file}>Télécharger</Download>}
              </article>
            )}
            {(m.subtitles ?? []).map(track => (
              <article key={track.file}>
                <div>
                  <h3>{track.label}</h3>
                  <p>{track.source}</p>
                </div>
                <Download file={track.file}>Sous-titres</Download>
              </article>
            ))}
            {!m.subtitles?.length && (
              <article>
                <div>
                  <h3>Sous-titres</h3>
                  <p>Aucune piste séparée disponible.</p>
                </div>
              </article>
            )}
            <article>
              <div>
                <h3>Manifeste</h3>
                <p>Chronologie et métadonnées de toutes les ressources.</p>
              </div>
              <Button variant="outlined" className="download" href="api/manifest" download="manifest.json">
                JSON<span aria-hidden="true">↓</span>
              </Button>
            </article>
          </div>
        </section>
        {m.package && (
          <section className="asset-delivery" id="package">
            <div className="section-top">
              <h2>Le paquet de l’épisode</h2>
              <p>
                {number.format(m.package.volumes.length)} volumes{" "}
                {m.package.status?.startsWith("archives-reconstructible") ? "reconstructibles" : "compressés"}
              </p>
            </div>
            {m.package.status?.startsWith("archives-reconstructible") && (
              <p role="status">
                Les archives absentes sont recréées au téléchargement et vérifiées contre leur SHA-256 d’origine. La
                livraison R2 est encore incomplète.
              </p>
            )}
            <div className="asset-actions">
              <Download file={m.package.manifest}>Manifeste</Download>
              <Download file={m.package.index}>Index des assets</Download>
              <Download file={m.package.readme}>Documentation</Download>
              <Download file={m.package.checksums}>SHA-256</Download>
            </div>
            <div className="volume-list">
              {m.package.volumes.slice(volumePage * 12, volumePage * 12 + 12).map(item => (
                <Card variant="outlined" key={item.file}>
                  <div>
                    <h3>{item.file.split("/").at(-1)}</h3>
                    <p>{size(item.bytes)}</p>
                  </div>
                  <Download file={item.file}>
                    {m.package?.status?.startsWith("archives-reconstructible")
                      ? "Recréer et télécharger"
                      : "Télécharger"}
                  </Download>
                </Card>
              ))}
            </div>
            {m.package.volumes.length > 12 && (
              <div className="asset-pagination">
                <Button
                  variant="outlined"
                  disabled={volumePage === 0}
                  onClick={() => setVolumePage(value => value - 1)}
                >
                  Précédent
                </Button>
                <span>
                  {volumePage + 1} / {Math.ceil(m.package.volumes.length / 12)}
                </span>
                <Button
                  variant="outlined"
                  disabled={(volumePage + 1) * 12 >= m.package.volumes.length}
                  onClick={() => setVolumePage(value => value + 1)}
                >
                  Suivant
                </Button>
              </div>
            )}
          </section>
        )}
        {m.dataset && (
          <section className="asset-delivery" id="dataset">
            <h2>Jeu de données et frames retenues</h2>
            {dataset && (
              <dl className="dataset-summary">
                <div>
                  <dt>Français</dt>
                  <dd>{dataset.captions?.french ?? "Non renseigné"} sous-titres</dd>
                </div>
                <div>
                  <dt>Japonais</dt>
                  <dd>
                    {japaneseASR
                      ? japaneseASRQualified
                        ? `${dataset.captions?.japanese ?? 0} segments — transcription japonaise locale (ASR)${dataset.captions?.japaneseAsrProof?.timestampGranularitySeconds ? `, fenêtres de ${dataset.captions.japaneseAsrProof.timestampGranularitySeconds} s` : ""}`
                        : "Transcription locale non validée"
                      : dataset.captions?.japanese
                        ? `${dataset.captions.japanese} sous-titres`
                        : dataset.captions?.japanese === 0
                          ? "0 — piste fournisseur indisponible"
                          : "Non renseigné"}
                  </dd>
                </div>
                {japaneseASRQualified && japaneseASR && (
                  <div>
                    <dt>Reconnaissance</dt>
                    <dd>Transcription automatique non relue ; mots et traduction non vérifiés</dd>
                  </div>
                )}
                {dataset.captions?.japaneseProof?.status === "unavailable" && (
                  <div>
                    <dt>Piste JA</dt>
                    <dd>Sous-titres officiels Crunchyroll indisponibles</dd>
                  </div>
                )}
                {dataset.japaneseLexiconConfirmedNames !== undefined && (
                  <div>
                    <dt>Noms JP</dt>
                    <dd>{dataset.japaneseLexiconConfirmedNames} noms confirmés dans le lexique</dd>
                  </div>
                )}
                {dataset.splits && (
                  <div>
                    <dt>Partitions</dt>
                    <dd>
                      {dataset.splits.train} train, {dataset.splits.validation} validation, {dataset.splits.test} test
                    </dd>
                  </div>
                )}
              </dl>
            )}
            <div className="asset-actions">
              <Download file={m.dataset.manifest}>Manifeste du dataset</Download>
              {m.dataset.files.map(file => (
                <Download key={file} file={file}>
                  {file.split("/").at(-1)}
                </Download>
              ))}
            </div>
            <div className="dataset-previews">
              {m.dataset.previews
                ?.slice(0, 12)
                .map(item => datasetPreview(item, m.fps))
                .map(item => (
                  <Card variant="outlined" key={item.file}>
                    <img src={assetURL(item.file)} alt={item.title} loading="lazy" />
                    <div>
                      <h3>{item.title}</h3>
                      {item.french && <p lang="fr">{item.french}</p>}
                      {item.japanese && (!japaneseASR || japaneseASRQualified) && <p lang="ja">{item.japanese}</p>}
                      {typeof item.timeSeconds === "number" && (
                        <Button variant="text" onClick={() => seek(item.timeSeconds!)}>
                          Voir à {timestamp(item.timeSeconds)}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
            </div>
            {datasetError && (
              <p className="error" role="status">
                {datasetError}
              </p>
            )}
          </section>
        )}
        {m.themes && (
          <section className="asset-delivery" id="themes">
            <h2>Thèmes M3 des moments sélectionnés</h2>
            <p className="resource-note">
              Couleurs des frames décodées, formes et typographie fournies par les tokens M3.
            </p>
            <div className="asset-actions">
              <Download file={m.themes.manifest}>Manifeste des thèmes</Download>
              {m.themes.files.map(file => (
                <Download key={file} file={file}>
                  {file.split("/").at(-1)}
                </Download>
              ))}
            </div>
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
      {themeError && (
        <p className="error" role="alert">
          {themeError}
        </p>
      )}
      <footer>
        <span className="brand-mark" aria-hidden="true">
          ◈
        </span>
        <span>Bun Video</span>
        <span>Un épisode. Toutes ses images.</span>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
