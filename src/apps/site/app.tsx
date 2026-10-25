import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyDynamicColor } from "@aphrody/m3-tokens/dynamic-color";
import "@aphrody/m3-tokens/m3-tokens.css";
import type { ShowcaseManifest } from "./collection";
import "./style.css";

type Work = ShowcaseManifest["works"][number];
const asset = (path: string) => {
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
    throw new TypeError("Showcase assets must stay inside the published timeline");
  const url = new URL(path, `${location.origin}/`);
  if (url.origin !== location.origin) throw new TypeError("Showcase assets must be same-origin");
  return url.href;
};

function Film({
  work,
  index,
  count,
  active,
  nearby,
  reduced,
  fullscreen,
  toggleFullscreen,
}: {
  work: Work;
  index: number;
  count: number;
  active: boolean;
  nearby: boolean;
  reduced: boolean;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [wantsPlay, setWantsPlay] = useState(!reduced);
  const [running, setRunning] = useState(false);
  const [position, setPosition] = useState(0);
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(!document.hidden);
  const duration = (work.durationFrames * work.fps.den) / work.fps.num;
  const playing = active && visible && wantsPlay;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (reduced) setWantsPlay(false);
  }, [reduced]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (!playing) {
      element.pause();
      return;
    }
    void element.play().catch(() => {
      setWantsPlay(false);
      setMessage("Appuyez sur Lire pour démarrer la vidéo.");
    });
    return () => element.pause();
  }, [playing, nearby]);
  const seek = (seconds: number) => {
    setPosition(seconds);
    if (video.current) video.current.currentTime = seconds;
  };
  const toggle = () => {
    setMessage("");
    setWantsPlay(value => !value);
  };
  return (
    <section
      className="film"
      data-index={index}
      aria-label={`${index + 1} sur ${count} : ${work.title}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="screen">
        <video
          ref={video}
          src={nearby ? asset(work.video!) : undefined}
          poster={work.poster ? asset(work.poster) : undefined}
          preload={active ? "auto" : nearby ? "metadata" : "none"}
          playsInline
          loop
          muted
          aria-label={work.title}
          onPlay={() => setRunning(true)}
          onPause={() => setRunning(false)}
          onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
          onError={() => {
            setMessage("Cette vidéo n’a pas pu être chargée.");
            setWantsPlay(false);
          }}
        >
          {work.captions && <track kind="captions" src={asset(work.captions)} srcLang="fr" label="Français" default />}
        </video>
      </div>
      <div className="film-top">
        <span className="timeline-catalog-link">Aphrody Video</span>
        <span className="chapter">
          {work.chapter ?? work.engine} · {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
        </span>
        <span className="chapter">Bun · vidéo native</span>
      </div>
      <div className="film-bottom">
        <div className="caption">
          <p className="eyebrow">
            {work.engine} / {work.features.slice(0, 3).join(" · ")}
          </p>
          <h1>{work.title}</h1>
          <p>{work.description}</p>
        </div>
        <div className="transport">
          <button onClick={toggle} aria-label={playing && running ? "Mettre en pause" : "Lire"}>
            {playing && running ? "Pause" : "Lire"}
          </button>
          <label className="seek">
            <span className="sr-only">Position dans {work.title}</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, duration - work.fps.den / work.fps.num)}
              step={work.fps.den / work.fps.num}
              value={position}
              onChange={event => {
                setWantsPlay(false);
                seek(Number(event.target.value));
              }}
              aria-valuetext={`${position.toFixed(1)} sur ${duration.toFixed(1)} secondes`}
            />
          </label>
          <output>
            {position.toFixed(1)} / {duration.toFixed(1)} s
          </output>
          <button
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Quitter le plein écran" : "Plein écran"}
          >
            {fullscreen ? "Quitter" : "Plein écran"}
          </button>
          <details>
            <summary>Source et preuves</summary>
            <div className="provenance">
              <p>{work.sourceRef ?? "packages/bun-video/src/apps/showcase"}</p>
              <p>
                {work.width} × {work.height} · {work.fps.num}/{work.fps.den} i/s
              </p>
              <p>
                {work.evidence.length
                  ? work.evidence.join(" · ")
                  : "Aucune qualification associée à cette composition."}
              </p>
              {work.code && (
                <pre>
                  <code>{work.code}</code>
                </pre>
              )}
              <a href="/showcase.json">Manifeste des résultats</a>
            </div>
          </details>
        </div>
        {message && (
          <p className="playback-status" role="status">
            {message}
          </p>
        )}
        <span className="scroll-hint">
          {index < count - 1 ? "Défiler pour la vidéo suivante ↓" : "Fin de la timeline"}
        </span>
      </div>
    </section>
  );
}

function App() {
  const [manifest, setManifest] = useState<ShowcaseManifest>();
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const feed = useRef<HTMLElement>(null);
  useEffect(() => {
    // Canonical Bun M3 token generator; no separate showcase palette.
    applyDynamicColor("#f4722b", { dark: true });
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/showcase.json", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Catalogue indisponible (${response.status})`);
        const data: ShowcaseManifest = await response.json();
        if (
          data.schema !== "bun-video/showcase/v1" ||
          !Array.isArray(data.works) ||
          data.works.some(work => typeof work.video !== "string" || !work.video || work.video.startsWith("/"))
        )
          throw new Error("La timeline n’accepte que des vidéos réellement rendues et publiées.");
        setManifest(data);
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!manifest || !feed.current) return;
    const workId = new URLSearchParams(location.search).get("v");
    const initial = workId ? manifest.works.findIndex(work => work.id === workId) : 0;
    if (initial >= 0) setActive(initial);
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries)
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6)
            setActive(Number((entry.target as HTMLElement).dataset.index));
      },
      { root: feed.current, threshold: [0.6] },
    );
    for (const film of feed.current.querySelectorAll(".film")) observer.observe(film);
    return () => observer.disconnect();
  }, [manifest]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === feed.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void feed.current?.requestFullscreen();
  };
  const page = (event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, a, input, audio, summary, iframe")) return;
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    const direction =
      event.key === "ArrowDown" || event.key === "PageDown"
        ? 1
        : event.key === "ArrowUp" || event.key === "PageUp"
          ? -1
          : 0;
    if (!direction || !manifest) return;
    event.preventDefault();
    feed.current
      ?.querySelectorAll<HTMLElement>(".film")
      [Math.max(0, Math.min(manifest.works.length - 1, active + direction))]?.scrollIntoView({
        behavior: reduced ? "instant" : "smooth",
        block: "start",
      });
  };
  return (
    <main ref={feed} className="timeline" aria-label="Timeline des vidéos Aphrody" tabIndex={0} onKeyDown={page}>
      {!manifest && (
        <div className="empty" role={error ? "alert" : "status"}>
          <h1>Aphrody Video</h1>
          <p>{error || "Chargement de la timeline…"}</p>
          {error && <button onClick={() => location.reload()}>Réessayer</button>}
        </div>
      )}
      {manifest?.works.length === 0 && (
        <div className="empty">
          <h1>Aucune vidéo dans la timeline</h1>
          <p>Les vidéos qualifiées apparaîtront ici.</p>
        </div>
      )}
      {manifest?.works.map((work, index) => (
        <Film
          key={work.id}
          work={work}
          index={index}
          count={manifest.works.length}
          active={index === active}
          nearby={Math.abs(index - active) <= 1}
          reduced={reduced}
          fullscreen={fullscreen}
          toggleFullscreen={toggleFullscreen}
        />
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
