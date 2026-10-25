// SPDX-License-Identifier: Apache-2.0
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VideoStudio, type StudioAsset } from "../studio";

type Section = "discover" | "pipeline" | "library" | "episode" | "data" | "labs" | "shortcuts" | "compositions";

interface Health {
  readonly status: string;
  readonly video: { readonly available: boolean; readonly decoder: string };
}

const sections: ReadonlyArray<{ id: Section; label: string; hint: string }> = [
  { id: "discover", label: "Découvrir", hint: "Recherche YouTube officielle" },
  { id: "pipeline", label: "Pipeline", hint: "Capture réseau, analyse, rendu" },
  { id: "library", label: "Bibliothèque", hint: "Lecture et métadonnées" },
  { id: "episode", label: "Atelier épisode", hint: "Analyse d’images" },
  { id: "data", label: "Données", hint: "Catalogue et exports" },
  { id: "labs", label: "Labs", hint: "DASH et HLS" },
  { id: "shortcuts", label: "Crunchyroll", hint: "PWA et extension" },
  { id: "compositions", label: "Compositions", hint: "Remotion et HyperFrames" },
];

function useSection(): [Section, (section: Section) => void] {
  const read = (): Section => {
    const value = location.hash.slice(1) as Section;
    return sections.some(section => section.id === value) ? value : "pipeline";
  };
  const [current, setCurrent] = useState<Section>(read);
  useEffect(() => {
    const onChange = () => setCurrent(read());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return [current, (section: Section) => (location.hash = section)];
}

function Library() {
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch("/api/video/library", { cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ assets: StudioAsset[] }>;
      })
      .then(body => setAssets(body.assets))
      .catch(() => setError("Bibliothèque indisponible."));
  }, []);
  if (error)
    return (
      <p role="alert" className="notice">
        {error}
      </p>
    );
  if (assets.length === 0) return <p className="notice">Aucun média dans la racine configurée.</p>;
  return <VideoStudio assets={assets} storageKey="bun-video-web-app" />;
}

interface YouTubeResult {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly channelTitle: string;
  readonly publishedAt: string;
  readonly thumbnail?: string;
  readonly player: string;
  readonly source: string;
}

function Discover() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<YouTubeResult[]>([]);
  const [selected, setSelected] = useState<YouTubeResult>();
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    setState("Recherche YouTube…");
    setSelected(undefined);
    try {
      const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const body = (await response.json()) as { items?: YouTubeResult[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setItems(body.items ?? []);
      setState(body.items?.length ? `${body.items.length} résultats · source YouTube officielle` : "Aucun résultat.");
    } catch (error) {
      setItems([]);
      setState(
        error instanceof Error && error.message === "youtube_search_unavailable"
          ? "Recherche YouTube non configurée sur ce serveur."
          : "Recherche indisponible. Réessayez plus tard.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="discover">
      <form className="form" onSubmit={submit}>
        <label>
          Rechercher dans YouTube
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            maxLength={160}
            required
          />
        </label>
        <button type="submit" className="action" disabled={busy || !query.trim()}>
          {busy ? "Recherche…" : "Rechercher"}
        </button>
      </form>
      <p className="notice" role="status" aria-live="polite">
        {state || "Les vidéos sont lues dans le lecteur officiel YouTube."}
      </p>
      {selected && (
        <div className="video-player">
          <iframe
            src={selected.player}
            title={selected.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
          <h2>{selected.title}</h2>
          <p>{selected.channelTitle}</p>
          <a href={selected.source} target="_blank" rel="noreferrer">
            Ouvrir sur YouTube
          </a>
        </div>
      )}
      <div className="video-results">
        {items.map(item => (
          <button className="video-result" type="button" key={item.id} onClick={() => setSelected(item)}>
            {item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" />}
            <span>
              <strong>{item.title}</strong>
              <small>
                {item.channelTitle}
                {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString()}` : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Embedded({ src, title }: { readonly src: string; readonly title: string }) {
  return <iframe className="embedded" src={src} title={title} loading="lazy" />;
}

function Compositions() {
  const [status, setStatus] = useState<string>("Vérification…");
  useEffect(() => {
    fetch("/api/compositions", { cache: "no-store" })
      .then(response => response.json() as Promise<{ remotion: { loaded: boolean }; hyperframes: { loaded: boolean } }>)
      .then(body =>
        setStatus(
          `Remotion : ${body.remotion.loaded ? "chargé" : "indisponible"} · HyperFrames : ${body.hyperframes.loaded ? "chargé" : "indisponible"}`,
        ),
      )
      .catch(() => setStatus("État des compositions indisponible."));
  }, []);
  const [probe, setProbe] = useState<string>("Aucun sondage lancé.");
  const runProbe = () => {
    setProbe("Sondage WebGPU en cours…");
    fetch("/api/webgpu/probe", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { available?: boolean; adapter?: unknown };
        setProbe(body.available ? "Adaptateur WebGPU disponible." : "WebGPU indisponible sur cet hôte.");
      })
      .catch(() => setProbe("Sondage WebGPU impossible (Chromium requis)."));
  };
  return (
    <>
      <p className="notice">{status}</p>
      <button type="button" className="action" onClick={runProbe}>
        Sonder WebGPU
      </button>
      <p className="notice" role="status" aria-live="polite">
        {probe}
      </p>
    </>
  );
}

function Pipeline() {
  const [url, setUrl] = useState("https://www.crunchyroll.com/");
  const [endpoint, setEndpoint] = useState("");
  const [state, setState] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    setState("Capture en cours…");
    fetch("/api/pipeline/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, ...(endpoint ? { endpoint } : {}) }),
    })
      .then(async response => {
        const body = (await response.json()) as { status?: string; error?: string };
        setState(response.ok ? "Capture terminée." : `Erreur : ${body.error ?? response.status}`);
      })
      .catch(() => setState("Capture impossible."))
      .finally(() => setBusy(false));
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        URL à capturer
        <input type="url" value={url} onChange={event => setUrl(event.currentTarget.value)} required />
      </label>
      <label>
        Point de terminaison CDP local (optionnel)
        <input
          type="text"
          value={endpoint}
          placeholder="ws://127.0.0.1:9222/…"
          onChange={event => setEndpoint(event.currentTarget.value)}
        />
      </label>
      <button type="submit" className="action" disabled={busy}>
        Lancer la capture
      </button>
      <p className="notice" role="status" aria-live="polite">
        {state}
      </p>
    </form>
  );
}

const views: Record<Section, () => ReactNode> = {
  discover: () => <Discover />,
  pipeline: () => <Pipeline />,
  library: () => <Library />,
  episode: () => <Embedded src="/episode/" title="Atelier épisode" />,
  data: () => <Embedded src="/site/" title="Données vidéo" />,
  labs: () => <Embedded src="/labs/hls/" title="Labs HLS" />,
  shortcuts: () => <Embedded src="/pwa/" title="Crunchyroll" />,
  compositions: () => <Compositions />,
};

function App() {
  const [section, go] = useSection();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [section]);
  const [health, setHealth] = useState<Health>();
  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then(response => response.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth(undefined));
  }, []);
  const current = sections.find(item => item.id === section)!;
  return (
    <div className="shell">
      <a className="skip" href="#content">
        Aller au contenu
      </a>
      <nav aria-label="Sections">
        <a className="brand" href="/" aria-label="Retour aux films Bun Video">
          Bun Video
        </a>
        <ul>
          {sections.map(item => (
            <li key={item.id}>
              <button type="button" aria-current={item.id === section ? "page" : undefined} onClick={() => go(item.id)}>
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </button>
            </li>
          ))}
        </ul>
        <footer role="status" aria-live="polite">
          {health
            ? health.video.available
              ? "Fournisseur vidéo actif"
              : "Fournisseur vidéo indisponible"
            : "Hors ligne"}
        </footer>
      </nav>
      <main id="content" tabIndex={-1} ref={main}>
        <header>
          <h1>{current.label}</h1>
          <p>{current.hint}</p>
        </header>
        <section aria-labelledby="page-title">{views[section]()}</section>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
