import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@aphrody/m3-primitives";
import { createProject, isProject, type StudioMode, type StudioProject } from "./project";
import "./style.css";

type LocalMedia = { file: File; url: string };
const modes: { id: StudioMode; label: string; icon: string }[] = [
  { id: "video", label: "Vidéo", icon: "◧" },
  { id: "animation", label: "Animation", icon: "✧" },
  { id: "photo", label: "Photo", icon: "▧" },
];
const timecode = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, "0")}`;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function responseJSON(response: Response) {
  if (!response.ok) throw new Error((await response.text()).slice(0, 300) || `Erreur ${response.status}`);
  return response.json();
}

export function AphrodyStudio() {
  const [project, setProject] = useState<StudioProject>(createProject);
  const [media, setMedia] = useState<Record<string, LocalMedia>>({});
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState<"media" | "projects">("media");
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState("Votre espace de création est prêt.");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [probe, setProbe] = useState<unknown>();
  const [capabilities, setCapabilities] = useState<unknown>();
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [zoom, setZoom] = useState(1);
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const localMedia = useRef(media);
  localMedia.current = media;
  const clip = project.clips.find(c => c.id === selected) ?? project.clips[0];
  const asset = project.assets.find(a => a.id === clip?.assetId);
  const source = asset ? media[asset.id] : undefined;
  const duration = project.clips.reduce((sum, c) => sum + c.end - c.start, 0);
  const update = (patch: Partial<StudioProject>) => setProject(p => ({ ...p, ...patch }));
  useEffect(
    () => () => {
      for (const value of Object.values(localMedia.current)) URL.revokeObjectURL(value.url);
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/studio/capabilities", { signal: controller.signal })
      .then(responseJSON)
      .then(setCapabilities)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setPosition(clip?.start ?? 0);
    setPlaying(false);
  }, [clip?.id]);
  useEffect(() => {
    if (!playing || project.mode !== "animation") return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setPosition(p => (p + (now - last) / 1000) % Math.max(1, clip ? clip.end - clip.start : 6));
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, project.mode, clip?.id]);

  async function action(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function importFiles(files: FileList | File[]) {
    const entries = Array.from(files);
    const available = entries.filter(f => /^(video|image|audio)\//.test(f.type));
    if (!available.length) {
      setStatus("Choisissez une image, une vidéo ou un fichier audio.");
      return;
    }
    const additions = available.map(file => {
      const existing = project.assets.find(a => a.name === file.name && a.size === file.size);
      return { id: existing?.id ?? crypto.randomUUID(), file };
    });
    setMedia(current => {
      const next = { ...current };
      for (const item of additions) {
        if (next[item.id]) URL.revokeObjectURL(next[item.id].url);
        next[item.id] = { file: item.file, url: URL.createObjectURL(item.file) };
      }
      return next;
    });
    setProject(current => ({
      ...current,
      assets: [
        ...current.assets,
        ...additions
          .filter(a => !current.assets.some(b => b.id === a.id))
          .map(a => ({ id: a.id, name: a.file.name, type: a.file.type, size: a.file.size })),
      ],
      clips: [
        ...current.clips,
        ...additions
          .filter(a => !current.clips.some(c => c.assetId === a.id))
          .map(a => ({ id: crypto.randomUUID(), assetId: a.id, start: 0, end: 6 })),
      ],
    }));
    setStatus(
      `${available.length} média${available.length > 1 ? "s" : ""} importé${available.length > 1 ? "s" : ""}. Les fichiers restent sur cet appareil.`,
    );
  }
  function seek(value: number) {
    setPosition(value);
    if (video.current) video.current.currentTime = value;
  }
  async function togglePlay() {
    if (project.mode === "animation") {
      setPlaying(p => !p);
      return;
    }
    if (!video.current) return;
    if (video.current.paused) {
      if (clip && (video.current.currentTime < clip.start || video.current.currentTime >= clip.end))
        video.current.currentTime = clip.start;
      await video.current.play();
    } else video.current.pause();
  }
  async function loadProjects() {
    await action(async () => {
      const result = await responseJSON(await fetch("/api/studio/projects"));
      const list = Array.isArray(result) ? result : result.projects;
      setSaved(Array.isArray(list) ? list : []);
      setPanel("projects");
    });
  }
  async function saveProject() {
    await action(async () => {
      await responseJSON(
        await fetch(`/api/studio/projects/${encodeURIComponent(project.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(project),
        }),
      );
      setStatus("Projet enregistré. Réimportez les médias locaux pour le reprendre sur un autre appareil.");
    });
  }
  async function openProject(id: string) {
    await action(async () => {
      const value = await responseJSON(await fetch(`/api/studio/projects/${encodeURIComponent(id)}`));
      const p = value.project ?? value;
      if (!isProject(p)) throw new Error("Le projet ne correspond pas au format Aphrody Studio.");
      setProject(p);
      setSelected("");
      setStatus("Projet ouvert. Réimportez les médias manquants depuis cet appareil.");
    });
  }
  async function exportImage() {
    await action(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = project.width;
      canvas.height = project.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Le rendu image n’est pas disponible.");
      context.fillStyle = project.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (image.current && image.current.complete && image.current.naturalWidth) {
        const img = image.current;
        const swap = project.photo.rotation % 180 !== 0;
        const scale = Math.min(
          canvas.width / (swap ? img.naturalHeight : img.naturalWidth),
          canvas.height / (swap ? img.naturalWidth : img.naturalHeight),
        );
        context.save();
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate((project.photo.rotation * Math.PI) / 180);
        context.filter = `brightness(${project.photo.brightness}%) contrast(${project.photo.contrast}%) saturate(${project.photo.saturation}%)`;
        context.drawImage(
          img,
          (-img.naturalWidth * scale) / 2,
          (-img.naturalHeight * scale) / 2,
          img.naturalWidth * scale,
          img.naturalHeight * scale,
        );
        context.restore();
      }
      context.fillStyle = project.titleColor;
      context.font = `600 ${project.titleSize}px sans-serif`;
      context.textAlign = "center";
      context.fillText(project.title, canvas.width / 2, canvas.height * 0.8, canvas.width * 0.9);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Échec du rendu PNG."))), "image/png"),
      );
      download(blob, `${project.name}.png`);
      setStatus("Image PNG exportée.");
    });
  }
  async function convertNative() {
    if (!source || !asset?.type.startsWith("image/")) return;
    await action(async () => {
      const response = await fetch(`/api/studio/image?format=webp&width=${project.width}&height=${project.height}`, {
        method: "POST",
        headers: { "content-type": asset.type },
        body: source.file,
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 300));
      download(await response.blob(), `${asset.name}.webp`);
      setStatus("Conversion WebP native terminée (source redimensionnée).");
    });
  }
  const photoFilter = `brightness(${project.photo.brightness}%) contrast(${project.photo.contrast}%) saturate(${project.photo.saturation}%)`;
  return (
    <div className="aphrody-studio">
      <header className="studio-header">
        <a className="studio-brand" href="/" aria-label="Aphrody Studio accueil">
          <span className="brand-mark" aria-hidden="true">
            a
          </span>
          <span>
            Aphrody <strong>Studio</strong>
          </span>
        </a>
        <div className="project-name">
          <span className="project-dot" aria-hidden="true" />
          <input
            aria-label="Nom du projet"
            value={project.name}
            maxLength={120}
            onChange={e => update({ name: e.target.value })}
          />
        </div>
        <div className="header-actions">
          <Button variant="outlined" disabled={busy} onClick={saveProject}>
            Enregistrer
          </Button>
          <Button
            onClick={() =>
              download(
                new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
                `${project.name}.aphrody.json`,
              )
            }
          >
            Télécharger le projet
          </Button>
        </div>
      </header>
      <nav className="mode-rail" aria-label="Atelier">
        {modes.map(mode => (
          <button
            key={mode.id}
            className={project.mode === mode.id ? "active" : ""}
            aria-pressed={project.mode === mode.id}
            onClick={() => {
              update({ mode: mode.id });
              setPlaying(false);
              video.current?.pause();
            }}
          >
            <span aria-hidden="true">{mode.icon}</span>
            {mode.label}
          </button>
        ))}
        <button className="rail-bottom" aria-pressed={showCapabilities} onClick={() => setShowCapabilities(v => !v)}>
          <span aria-hidden="true">ⓘ</span>Capacités
        </button>
      </nav>
      <aside className="media-panel">
        <div className="panel-heading">
          <h2>Votre matière première</h2>
          <span>{project.assets.length}</span>
        </div>
        <div className="panel-tabs">
          <button aria-pressed={panel === "media"} onClick={() => setPanel("media")}>
            Médias
          </button>
          <button aria-pressed={panel === "projects"} onClick={loadProjects}>
            Projets
          </button>
        </div>
        <input
          ref={upload}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          onChange={e => {
            if (e.target.files) void importFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={projectInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0];
            if (f)
              void action(async () => {
                const p = JSON.parse(await f.text());
                if (!isProject(p)) throw new Error("Projet Aphrody invalide.");
                setProject(p);
                setSelected("");
                setStatus("Projet restauré. Réimportez ses médias locaux.");
              });
            e.target.value = "";
          }}
        />
        {panel === "media" ? (
          <>
            <button
              className="import-zone"
              onClick={() => upload.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                void importFiles(e.dataTransfer.files);
              }}
            >
              <span aria-hidden="true">＋</span>
              <strong>Importer des médias</strong>
              <small>
                Glissez vos fichiers ici
                <br />
                ou parcourez cet appareil
              </small>
            </button>
            <div className="asset-grid">
              {project.assets.map(a => (
                <button
                  key={a.id}
                  className={`asset-card ${a.id === asset?.id ? "selected" : ""}`}
                  onClick={() => {
                    const c = project.clips.find(c => c.assetId === a.id);
                    if (c) setSelected(c.id);
                  }}
                >
                  <div className="asset-thumb">
                    {a.type.startsWith("image/") && media[a.id] ? (
                      <img src={media[a.id].url} alt="" />
                    ) : (
                      <span aria-hidden="true">{a.type.startsWith("video/") ? "▷" : "♫"}</span>
                    )}
                  </div>
                  <strong>{a.name}</strong>
                  <small>{media[a.id] ? `${(a.size / 1e6).toFixed(1)} Mo` : "À réimporter"}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="saved-projects">
            {saved.length ? (
              saved.map(p => (
                <button key={p.id} onClick={() => openProject(p.id)}>
                  {p.name}
                </button>
              ))
            ) : (
              <p>Aucun projet enregistré sur ce studio.</p>
            )}
            <Button variant="outlined" onClick={() => projectInput.current?.click()}>
              Ouvrir un projet JSON
            </Button>
          </div>
        )}
        <div className="privacy-note">
          <span aria-hidden="true">⌁</span>
          <p>
            Vos sources restent locales.
            <br />
            Vous choisissez chaque envoi au studio.
          </p>
        </div>
      </aside>
      <main className="workspace">
        <div className="workspace-toolbar">
          <div>
            <span className="workspace-kicker">{modes.find(m => m.id === project.mode)?.label}</span>
            <h1>
              {project.mode === "photo"
                ? "Donnez forme à votre image."
                : project.mode === "animation"
                  ? "Mettez vos idées en mouvement."
                  : "Chaque histoire commence ici."}
            </h1>
          </div>
          <select aria-label="Zoom aperçu" value={zoom} onChange={e => setZoom(Number(e.target.value))}>
            <option value={0.75}>75 %</option>
            <option value={1}>Ajuster</option>
            <option value={1.25}>125 %</option>
          </select>
        </div>
        <section className="preview-well" aria-label="Moniteur de création">
          <div
            className="preview-stage"
            style={{
              aspectRatio: `${project.width}/${project.height}`,
              background: project.background,
              transform: `scale(${zoom})`,
            }}
          >
            {source && asset?.type.startsWith("image/") ? (
              <img
                ref={image}
                className="preview-image"
                src={source.url}
                alt={asset.name}
                style={{ filter: photoFilter, transform: `rotate(${project.photo.rotation}deg)` }}
              />
            ) : source && /^(video|audio)\//.test(asset?.type ?? "") ? (
              <video
                key={source.url}
                ref={video}
                src={source.url}
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onLoadedMetadata={e => {
                  const length = e.currentTarget.duration;
                  if (clip && Number.isFinite(length) && length > 0)
                    setProject(p => ({
                      ...p,
                      clips: p.clips.map(c => (c.id === clip.id ? { ...c, end: Math.min(c.end, length) } : c)),
                    }));
                }}
                onTimeUpdate={e => {
                  setPosition(e.currentTarget.currentTime);
                  if (clip && e.currentTarget.currentTime >= clip.end) {
                    e.currentTarget.pause();
                    seek(clip.start);
                  }
                }}
                onError={() => setStatus("Ce média ne peut pas être prévisualisé par ce navigateur.")}
              />
            ) : (
              <div className="preview-empty">
                <span aria-hidden="true">a</span>
                <p>{asset ? "Réimportez ce média pour afficher l’aperçu." : "Votre prochaine création"}</p>
              </div>
            )}
            <div
              className="preview-title"
              style={{
                color: project.titleColor,
                fontSize: `clamp(12px, ${(project.titleSize / project.width) * 60}vw, ${project.titleSize}px)`,
                opacity: project.mode === "animation" ? Math.min(1, position / 0.8) : 1,
                transform:
                  project.mode === "animation" ? `translateY(${Math.max(0, 1 - position / 0.8) * 30}px)` : undefined,
              }}
            >
              {project.title}
            </div>
          </div>
        </section>
        <div className="transport">
          <span>{timecode(position)}</span>
          <div>
            <button aria-label="Retour au début" onClick={() => seek(clip?.start ?? 0)}>
              ↤
            </button>
            <button
              className="play-button"
              aria-label={playing ? "Pause" : "Lire"}
              disabled={project.mode !== "animation" && (!source || asset?.type.startsWith("image/"))}
              onClick={() => void action(togglePlay)}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button
              aria-label="Avancer d’une image"
              onClick={() => seek(Math.min(clip?.end ?? 6, position + 1 / project.fps))}
            >
              ↦
            </button>
          </div>
          <span>
            {project.width} × {project.height}
            <small>{project.fps} i/s</small>
          </span>
        </div>
        <section className="timeline" aria-label="Timeline">
          <div className="timeline-heading">
            <h2>Timeline</h2>
            <span>{timecode(duration || 6)}</span>
            <Button
              variant="text"
              disabled={!clip}
              onClick={() => {
                if (!clip) return;
                const copy = { ...clip, id: crypto.randomUUID() };
                update({ clips: [...project.clips, copy] });
                setSelected(copy.id);
              }}
            >
              Dupliquer le plan
            </Button>
          </div>
          <div className="timeline-ruler">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>{timecode(((duration || 6) * i) / 6)}</span>
            ))}
          </div>
          <div className="timeline-track">
            <span className="track-label">Image</span>
            <div className="track-clips">
              {project.clips.length ? (
                project.clips.map((c, index) => (
                  <button
                    key={c.id}
                    className={`timeline-clip ${clip?.id === c.id ? "selected" : ""}`}
                    style={{ flexGrow: c.end - c.start }}
                    onClick={() => setSelected(c.id)}
                  >
                    <small>{index + 1}</small>
                    {project.assets.find(a => a.id === c.assetId)?.name}
                    <span>{(c.end - c.start).toFixed(1)} s</span>
                  </button>
                ))
              ) : (
                <button className="timeline-placeholder" onClick={() => upload.current?.click()}>
                  ＋ Ajoutez votre premier média
                </button>
              )}
            </div>
          </div>
          <div className="timeline-track">
            <span className="track-label">Texte</span>
            <div className="text-clip">
              T <span>{project.title || "Titre vide"}</span>
            </div>
          </div>
          <input
            className="timeline-scrubber"
            aria-label="Position de lecture"
            type="range"
            min={clip?.start ?? 0}
            max={clip?.end ?? 6}
            step={1 / project.fps}
            value={position}
            onChange={e => seek(Number(e.target.value))}
          />
        </section>
      </main>
      <aside className="inspector">
        <div className="panel-heading">
          <h2>Votre composition</h2>
          <span aria-hidden="true">☷</span>
        </div>
        <section>
          <h3>Format</h3>
          <label>
            Cadre
            <select
              value={`${project.width}x${project.height}`}
              onChange={e => {
                const [width, height] = e.target.value.split("x").map(Number);
                update({ width, height });
              }}
            >
              <option value="1920x1080">Paysage · 16:9</option>
              <option value="1080x1920">Portrait · 9:16</option>
              <option value="1080x1080">Carré · 1:1</option>
              <option value="1280x720">Paysage · 720p</option>
            </select>
          </label>
          <label>
            Images par seconde
            <select value={project.fps} onChange={e => update({ fps: Number(e.target.value) })}>
              {[24, 25, 30, 60].map(f => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="color-field">
            Fond
            <input type="color" value={project.background} onChange={e => update({ background: e.target.value })} />
          </label>
        </section>
        <section>
          <h3>Texte à l’image</h3>
          <textarea
            aria-label="Texte à l’image"
            rows={3}
            maxLength={300}
            value={project.title}
            onChange={e => update({ title: e.target.value })}
          />
          <label>
            Taille <output>{project.titleSize} px</output>
            <input
              type="range"
              min={16}
              max={160}
              value={project.titleSize}
              onChange={e => update({ titleSize: Number(e.target.value) })}
            />
          </label>
          <label className="color-field">
            Couleur
            <input type="color" value={project.titleColor} onChange={e => update({ titleColor: e.target.value })} />
          </label>
        </section>
        {project.mode === "photo" ? (
          <section>
            <h3>Réglages photo</h3>
            {(
              [
                { key: "brightness", label: "Luminosité" },
                { key: "contrast", label: "Contraste" },
                { key: "saturation", label: "Saturation" },
              ] as const
            ).map(control => (
              <label key={control.key}>
                {control.label}
                <output>{project.photo[control.key]} %</output>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={project.photo[control.key]}
                  onChange={e => update({ photo: { ...project.photo, [control.key]: Number(e.target.value) } })}
                />
              </label>
            ))}
            <Button
              variant="outlined"
              onClick={() => update({ photo: { ...project.photo, rotation: (project.photo.rotation + 90) % 360 } })}
            >
              Tourner de 90°
            </Button>
          </section>
        ) : (
          clip && (
            <section>
              <h3>Plan sélectionné</h3>
              <label>
                Entrée (secondes)
                <input
                  type="number"
                  min={0}
                  max={clip.end - 0.01}
                  step={0.01}
                  value={clip.start}
                  onChange={e => {
                    const start = Number(e.target.value);
                    if (Number.isFinite(start) && start >= 0 && start < clip.end)
                      update({ clips: project.clips.map(c => (c.id === clip.id ? { ...c, start } : c)) });
                  }}
                />
              </label>
              <label>
                Sortie (secondes)
                <input
                  type="number"
                  min={clip.start + 0.01}
                  step={0.01}
                  value={clip.end}
                  onChange={e => {
                    const end = Number(e.target.value);
                    if (Number.isFinite(end) && end > clip.start && end <= 86400)
                      update({ clips: project.clips.map(c => (c.id === clip.id ? { ...c, end } : c)) });
                  }}
                />
              </label>
              <div className="clip-actions">
                <button
                  disabled={project.clips.indexOf(clip) === 0}
                  onClick={() => {
                    const clips = [...project.clips];
                    const i = clips.indexOf(clip);
                    if (i > 0) {
                      [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
                      update({ clips });
                    }
                  }}
                >
                  Déplacer avant
                </button>
                <button onClick={() => update({ clips: project.clips.filter(c => c.id !== clip.id) })}>Retirer</button>
              </div>
            </section>
          )
        )}
        <section className="export-section">
          <h3>Sortie</h3>
          <Button
            disabled={busy || (project.mode !== "animation" && !asset?.type.startsWith("image/"))}
            onClick={exportImage}
          >
            Exporter l’image PNG
          </Button>
          <Button
            variant="outlined"
            disabled={busy || !source || !asset?.type.startsWith("image/")}
            onClick={convertNative}
          >
            Convertir la source en WebP
          </Button>
          {source && asset?.type.startsWith("video/") && (
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setProbe(
                    await responseJSON(await fetch("/api/studio/video/probe", { method: "POST", body: source.file })),
                  );
                  setStatus("Analyse native du média terminée.");
                })
              }
            >
              Analyser la source vidéo
            </Button>
          )}
          <p>
            Le projet conserve les plans et réglages. L’export vidéo sera disponible lorsqu’un moteur de rendu sera
            connecté.
          </p>
          {probe !== undefined && (
            <details>
              <summary>Analyse du média</summary>
              <pre>{JSON.stringify(probe, null, 2)}</pre>
            </details>
          )}
        </section>
      </aside>
      <footer className="studio-status" role="status" aria-live="polite">
        <span className={busy ? "busy-dot" : "status-dot"} />
        {busy ? "Traitement en cours…" : status}
        <span className="status-local">Aphrody Studio</span>
      </footer>
      {showCapabilities && (
        <div className="capabilities-sheet" role="dialog" aria-modal="true" aria-labelledby="cap-title">
          <div>
            <h2 id="cap-title">Capacités du studio</h2>
            <button autoFocus aria-label="Fermer les capacités" onClick={() => setShowCapabilities(false)}>
              ✕
            </button>
          </div>
          <p>Les capacités sont rapportées par le serveur de ce studio.</p>
          <pre>
            {capabilities
              ? JSON.stringify(capabilities, null, 2)
              : "Le serveur n’a pas encore communiqué ses capacités."}
          </pre>
          <p>Montage local, prévisualisation et documents de projet restent utilisables sans moteur natif connecté.</p>
        </div>
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<AphrodyStudio />);
