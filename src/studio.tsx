import { useEffect, useMemo, useRef, useState } from "react";
import type { YtDlpResult } from "./ytdlp";
import type { CrawlerCache } from "./cache";

export interface StudioSubtitle {
  readonly src: string;
  readonly srclang: string;
  readonly label: string;
  readonly default?: boolean;
}
export interface StudioVariant {
  readonly label: string;
  readonly src: string;
}
export interface StudioChapter {
  readonly title: string;
  readonly start: number;
}
export interface StudioAsset {
  readonly id: string;
  readonly title: string;
  readonly src: string;
  readonly type?: string;
  readonly poster?: string;
  readonly alt?: string;
  readonly crossOrigin?: "anonymous" | "use-credentials";
  readonly subtitles?: readonly StudioSubtitle[];
  readonly variants?: readonly StudioVariant[];
  readonly chapters?: readonly StudioChapter[];
}
export type VideoStudioStatus = "loading" | "ready" | "failed";
export interface VideoStudioProps {
  readonly assets: readonly StudioAsset[];
  readonly initialAssetId?: string;
  readonly className?: string;
  readonly cache?: CrawlerCache;
  readonly storageKey?: string;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  readonly onAssetSelect?: (asset: StudioAsset) => void;
  readonly onPlayback?: (state: { currentTime: number; duration: number; paused: boolean }) => void;
  readonly onStatus?: (status: VideoStudioStatus) => void;
}

const isHttpSource = (source: string) => /^https?:$/i.test(URL.canParse(source) ? new URL(source).protocol : "");

/** Compact React studio surface for browsing assets and driving the Bun Video pipeline. */
export function VideoStudio({
  assets,
  initialAssetId,
  className,
  cache,
  storageKey,
  autoPlay = false,
  loop = false,
  muted = false,
  onAssetSelect,
  onPlayback,
  onStatus,
}: VideoStudioProps) {
  const [localAssets, setLocalAssets] = useState<readonly StudioAsset[]>(() => {
    if (!storageKey || typeof localStorage === "undefined") return assets;
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? assets;
    } catch {
      return assets;
    }
  });
  const first = initialAssetId ?? localAssets[0]?.id;
  const [selectedId, setSelectedId] = useState(first);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [metadata, setMetadata] = useState<YtDlpResult | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<VideoStudioStatus>("loading");
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(muted);
  const [caption, setCaption] = useState(-1);
  const [textTracks, setTextTracks] = useState<{ index: number; label: string }[]>([]);
  const [variantSrc, setVariantSrc] = useState<string | undefined>();
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const blobUrls = useRef(new Set<string>());
  const selected = useMemo(
    () => localAssets.find(asset => asset.id === selectedId) ?? localAssets[0],
    [localAssets, selectedId],
  );
  useEffect(() => {
    if (!storageKey || typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey, JSON.stringify(localAssets.filter(asset => !asset.src.startsWith("blob:"))));
  }, [localAssets, storageKey]);
  useEffect(() => {
    setVariantSrc(undefined);
    setAttempt(0);
    setStatus(selected ? "loading" : "ready");
  }, [selectedId]);
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);
  useEffect(() => {
    setCaption(-1);
    setTextTracks([]);
  }, [selectedId, variantSrc]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [selectedId, playbackRate, variantSrc]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [selectedId, volume, variantSrc]);
  useEffect(() => {
    const mediaSession = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    const video = videoRef.current;
    if (!mediaSession || !video) return;
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => void video.play()],
      ["pause", () => video.pause()],
      [
        "seekbackward",
        () => {
          video.currentTime = Math.max(0, video.currentTime - 10);
        },
      ],
      [
        "seekforward",
        () => {
          video.currentTime += 10;
        },
      ],
      [
        "seekto",
        details => {
          if (details.seekTime !== undefined) video.currentTime = details.seekTime;
        },
      ],
    ];
    for (const [action, handler] of actions)
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        /* browser may not implement every action */
      }
    if (selected)
      mediaSession.metadata = new MediaMetadata({
        title: selected.title,
        artwork: selected.poster ? [{ src: selected.poster }] : undefined,
      });
    return () => {
      for (const [action] of actions)
        try {
          mediaSession.setActionHandler(action, null);
        } catch {}
    };
  }, [selected, selectedId]);
  const selectedIndex = selected ? localAssets.findIndex(asset => asset.id === selected.id) : -1;
  useEffect(() => {
    if (selected) onAssetSelect?.(selected);
  }, [onAssetSelect, selected]);
  const selectRelative = (delta: number) => {
    if (selectedIndex < 0 || localAssets.length === 0) return;
    const next = localAssets[(selectedIndex + delta + localAssets.length) % localAssets.length];
    setSelectedId(next.id);
    setMetadata(null);
    setError(null);
  };
  const addUrl = () => {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("URL HTTP(S) requise");
      const asset = { id: `url-${Date.now()}`, title: parsed.hostname + parsed.pathname, src: parsed.href };
      setLocalAssets(current => [...current, asset]);
      setSelectedId(asset.id);
      setUrl("");
      setMetadata(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "URL invalide");
    }
  };
  const inspectSelected = async () => {
    if (!selected || !isHttpSource(selected.src)) return;
    setLoadingMetadata(true);
    setError(null);
    try {
      const key = `yt-dlp:${selected.src}`;
      const cached = await cache?.get<YtDlpResult>(key);
      const result =
        cached ??
        (await fetch(`/api/video/extract?src=${encodeURIComponent(selected.src)}`).then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return (await response.json()) as YtDlpResult;
        }));
      if (!cached) await cache?.set(key, result);
      setMetadata(result ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMetadata(false);
    }
  };
  const addFile = (file: File) => {
    const asset = { id: `file-${Date.now()}`, title: file.name, src: URL.createObjectURL(file), type: file.type };
    blobUrls.current.add(asset.src);
    setLocalAssets(current => [...current, asset]);
    setSelectedId(asset.id);
    setError(null);
  };
  const addDropped = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && (file.type.startsWith("video/") || file.type.startsWith("audio/"))) addFile(file);
    else if (file) setError("Le fichier doit être vidéo ou audio");
  };
  const removeAsset = (id: string) => {
    const asset = localAssets.find(item => item.id === id);
    if (asset?.src.startsWith("blob:")) {
      URL.revokeObjectURL(asset.src);
      blobUrls.current.delete(asset.src);
    }
    const remaining = localAssets.filter(item => item.id !== id);
    setLocalAssets(remaining);
    if (selectedId === id) setSelectedId(remaining[0]?.id);
    setMetadata(null);
  };
  useEffect(
    () => () => {
      for (const url of blobUrls.current) URL.revokeObjectURL(url);
      blobUrls.current.clear();
    },
    [],
  );
  const handleKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const key = event.key.toLowerCase();
    if (key === "arrowright" || key === "arrowleft" || key === "j" || key === "l") {
      event.preventDefault();
      const delta = key === "arrowright" || key === "l" ? 10 : -10;
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(end, Math.max(0, video.currentTime + delta));
    } else if (event.key === " " || key === "k") {
      event.preventDefault();
      void (video.paused ? video.play() : video.pause());
    } else if (key === "m") {
      event.preventDefault();
      setIsMuted(current => !current);
    } else if (key === "c" && textTracks.length > 0) {
      event.preventDefault();
      selectCaption(caption === -1 ? 0 : -1);
    } else if (key === "f") {
      event.preventDefault();
      fullscreen();
    } else if (key === "p") {
      event.preventDefault();
      pictureInPicture();
    }
  };
  const syncTextTracks = () => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks) return;
    setTextTracks(
      Array.from(tracks).map((track, index) => ({
        index,
        label: track.label || track.language || `Sous-titre ${index + 1}`,
      })),
    );
    setCaption(Array.from(tracks).findIndex(track => track.mode === "showing"));
  };
  const selectCaption = (index: number) => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks || index < -1 || index >= tracks.length) return;
    Array.from(tracks).forEach((track, current) => {
      track.mode = current === index ? "showing" : "disabled";
    });
    setCaption(index);
  };
  const reportPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const state = {
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
    };
    setProgress(state);
    if (storageKey && selected)
      localStorage.setItem(`${storageKey}:position:${selected.id}`, String(state.currentTime));
    onPlayback?.(state);
  };
  const restorePosition = () => {
    const video = videoRef.current;
    if (!video || !storageKey || !selected) return;
    const value = Number(localStorage.getItem(`${storageKey}:position:${selected.id}`));
    if (Number.isFinite(value) && value > 0 && value < video.duration) video.currentTime = value;
    reportPlayback();
  };
  const fullscreen = () => {
    void videoRef.current?.requestFullscreen?.();
  };
  const pictureInPicture = () => {
    const video = videoRef.current;
    if (video && "requestPictureInPicture" in video)
      void (video as HTMLVideoElement & { requestPictureInPicture(): Promise<unknown> }).requestPictureInPicture();
  };
  return (
    <section
      className={className}
      aria-label="Bun Video Studio"
      tabIndex={0}
      onKeyDown={handleKeys}
      onDragOver={event => event.preventDefault()}
      onDrop={addDropped}
    >
      <aside>
        <strong>Bibliothèque</strong>
        <input
          type="file"
          accept="video/*,audio/*"
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) addFile(file);
          }}
        />
        <form
          onSubmit={event => {
            event.preventDefault();
            addUrl();
          }}
        >
          <input value={url} onChange={event => setUrl(event.target.value)} placeholder="URL vidéo HTTPS" type="url" />
          <button type="submit">Ajouter</button>
        </form>
        {localAssets.map(asset => (
          <div key={asset.id} role="group" aria-label={asset.title}>
            <button
              type="button"
              aria-pressed={asset.id === selected?.id}
              onClick={() => {
                setError(null);
                setSelectedId(asset.id);
              }}
            >
              {asset.title}
            </button>
            <button type="button" aria-label={`Supprimer ${asset.title}`} onClick={() => removeAsset(asset.id)}>
              ×
            </button>
          </div>
        ))}
      </aside>
      <main>
        {selected ? (
          <video
            ref={videoRef}
            key={`${selected.id}-${variantSrc ?? selected.src}-${attempt}`}
            controls
            playsInline
            preload="metadata"
            autoPlay={autoPlay}
            loop={loop}
            muted={isMuted}
            crossOrigin={selected.crossOrigin}
            poster={selected.poster}
            aria-label={selected.alt ?? selected.title}
            src={variantSrc ?? selected.src}
            onLoadedMetadata={() => {
              setStatus("ready");
              syncTextTracks();
              restorePosition();
            }}
            onTimeUpdate={reportPlayback}
            onPlay={reportPlayback}
            onPause={reportPlayback}
            onEnded={() => selectRelative(1)}
            onError={() => {
              setStatus("failed");
              setError(`Lecture impossible : ${selected.title}`);
            }}
          >
            {selected.subtitles?.map(track => (
              <track
                key={`${track.srclang}-${track.src}`}
                kind="subtitles"
                src={track.src}
                srcLang={track.srclang}
                label={track.label}
                default={track.default}
              />
            ))}
          </video>
        ) : (
          <p>Aucun média sélectionné.</p>
        )}
        {selected && (
          <p>
            {selected.title}
            {selected.type ? ` · ${selected.type}` : ""}
          </p>
        )}
        {selected && <progress max={progress.duration || 1} value={progress.currentTime} aria-label="Progression" />}
        <p role="status" aria-live="polite">
          {status === "loading" ? "Chargement…" : status === "failed" ? "Lecture indisponible" : "Prêt à lire"}
        </p>
        {selected?.chapters && (
          <nav aria-label="Chapitres">
            {selected.chapters.map(chapter => (
              <button
                key={`${chapter.start}-${chapter.title}`}
                type="button"
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = chapter.start;
                }}
              >
                {chapter.title}
              </button>
            ))}
          </nav>
        )}
        {selected && (
          <nav aria-label="Contrôles de file">
            <button type="button" onClick={() => selectRelative(-1)}>
              Précédent
            </button>
            <button type="button" onClick={() => selectRelative(1)}>
              Suivant
            </button>
          </nav>
        )}
        {selected && (
          <nav aria-label="Affichage">
            <button type="button" onClick={fullscreen}>
              Plein écran
            </button>
            <button type="button" onClick={pictureInPicture}>
              Picture-in-Picture
            </button>
          </nav>
        )}
        {selected && (
          <label>
            Vitesse{" "}
            <select value={playbackRate} onChange={event => setPlaybackRate(Number(event.target.value))}>
              <option value="0.5">0,5×</option>
              <option value="0.75">0,75×</option>
              <option value="1">1×</option>
              <option value="1.25">1,25×</option>
              <option value="1.5">1,5×</option>
              <option value="2">2×</option>
            </select>
          </label>
        )}
        {selected && (
          <label>
            Volume{" "}
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={event => setVolume(Number(event.target.value))}
            />
          </label>
        )}
        {selected && (
          <button type="button" aria-pressed={isMuted} onClick={() => setIsMuted(current => !current)}>
            {isMuted ? "Activer le son" : "Couper le son"}
          </button>
        )}
        {textTracks.length > 0 && (
          <label>
            Sous-titres{" "}
            <select value={caption} onChange={event => selectCaption(Number(event.target.value))}>
              <option value={-1}>Désactivés</option>
              {textTracks.map(track => (
                <option key={track.index} value={track.index}>
                  {track.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected?.variants && (
          <label>
            Qualité{" "}
            <select
              value={variantSrc ?? selected.src}
              onChange={event => setVariantSrc(event.target.value === selected.src ? undefined : event.target.value)}
            >
              <option value={selected.src}>Auto</option>
              {selected.variants.map(variant => (
                <option key={variant.src} value={variant.src}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected && isHttpSource(selected.src) && (
          <button type="button" onClick={() => void inspectSelected()} disabled={loadingMetadata}>
            {loadingMetadata ? "Analyse…" : "Analyser avec yt-dlp"}
          </button>
        )}
        {metadata && (
          <pre>
            {JSON.stringify(
              { title: metadata.title, id: metadata.id, formats: metadata.formats?.length ?? 0 },
              null,
              2,
            )}
          </pre>
        )}
        {error?.startsWith("Lecture impossible") && selected && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStatus("loading");
              setAttempt(value => value + 1);
            }}
          >
            Réessayer
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </main>
    </section>
  );
}
