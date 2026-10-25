import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./video-data-site.css";

type Row = Record<string, unknown>;
type Overview = { sources: number; entries: number; resources: number; cache: { redis: string } };
async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Opération indisponible");
  return data;
}
function App() {
  const [table, setTable] = useState("capture_entries"),
    [rows, setRows] = useState<Row[]>([]),
    [columns, setColumns] = useState<string[]>([]),
    [total, setTotal] = useState(0);
  const requestVersion = useRef(0);
  const [overview, setOverview] = useState<Overview>(),
    [status, setStatus] = useState("Chargement du catalogue…"),
    [selectedSource, setSelectedSource] = useState("");
  const [file, setFile] = useState<File>(),
    [format, setFormat] = useState("jsonl"),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0);
  const [jobs, setJobs] = useState("[]"),
    [exportURL, setExportURL] = useState<string>();
  async function load() {
    const version = ++requestVersion.current;
    const [info, result] = await Promise.all([
      api("/api/overview"),
      api("/api/query", {
        method: "POST",
        body: JSON.stringify({
          table,
          where: selectedSource ? { sourceId: selectedSource } : undefined,
          limit: 75,
          offset: page * 75,
        }),
      }),
    ]);
    if (version !== requestVersion.current) return;
    setOverview(info);
    setRows(result.rows);
    setColumns(result.columns);
    setTotal(result.total);
    setStatus(`${result.total} entrées dans cette vue.`);
  }
  useEffect(() => {
    void load().catch(error => setStatus(error.message));
  }, [table, selectedSource, page]);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setExportURL(undefined);
    try {
      await run();
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Opération indisponible");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <div className="mark" aria-hidden="true">
          ▶
        </div>
        <div>
          <h1>Bun Video</h1>
          <p>Sources, flux et rendus dans un seul atelier.</p>
        </div>
        <span className="runtime">Bun natif</span>
      </header>
      <section className="toolbar" aria-label="Actions du corpus">
        <div>
          <h2>Corpus enregistré</h2>
          <p>
            {overview
              ? `${overview.sources} sources · ${overview.entries} requêtes · ${overview.resources} ressources`
              : "Lecture du catalogue"}
          </p>
        </div>
        <form
          onSubmit={event => {
            event.preventDefault();
            void action(async () => {
              if (!file) throw new Error("Sélectionner un fichier HAR.");
              const form = new FormData();
              form.set("capture", file);
              const response = await fetch("/api/import", { method: "POST", body: form });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error);
              setStatus(`${result.entries} requêtes importées.`);
            });
          }}
        >
          <label htmlFor="capture">Capture réseau HAR</label>
          <input
            id="capture"
            type="file"
            accept=".har,application/json"
            onChange={event => setFile(event.target.files?.[0])}
          />
          <button disabled={busy || !file}>Importer</button>
        </form>
      </section>
      <section className="workspace">
        <aside>
          <h2>Explorer</h2>
          <nav aria-label="Tables du corpus">
            {[
              ["capture_entries", "Réseau"],
              ["captured_resources", "Ressources"],
              ["sources", "Sources"],
              ["providers", "Extracteurs"],
              ["capabilities", "API"],
              ["jobs", "Rendus"],
              ["qualifications", "Qualifications"],
            ].map(([name, label]) => (
              <button
                key={name}
                aria-current={table === name ? "page" : undefined}
                onClick={() => {
                  setTable(name!);
                  setPage(0);
                  setSelectedSource("");
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <p className="cache">Redis : {overview?.cache?.redis ?? "…"}</p>
          <p className="hint">
            Un extracteur catalogué n’est pas un site testé. Les captures chiffrées restent identifiées.
          </p>
        </aside>
        <section className="data">
          <div className="data-heading">
            <h2>
              {
                (
                  {
                    capture_entries: "Requêtes réseau",
                    captured_resources: "Ressources extraites",
                    sources: "Sources",
                    providers: "Extracteurs",
                    capabilities: "API Bun Video",
                    jobs: "Rendus",
                    qualifications: "Qualifications",
                  } as Row
                )[table] as string
              }
            </h2>
            <button disabled={busy} onClick={() => void load().catch(error => setStatus(error.message))}>
              Actualiser
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map(column => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={String(row.id ?? index)}>
                    {columns.map(column => (
                      <td key={column}>{String(row[column] ?? "—")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              Précédent
            </button>
            <span>
              {total ? page * 75 + 1 : 0}–{Math.min((page + 1) * 75, total)} / {total}
            </span>
            <button disabled={(page + 1) * 75 >= total} onClick={() => setPage(page + 1)}>
              Suivant
            </button>
          </div>
        </section>
      </section>
      <section className="delivery">
        <div>
          <h2>Créer un dataset</h2>
          <p>Documents structurés et métadonnées ; sessions et jetons restent dans les magasins privés.</p>
          <label htmlFor="format">Format</label>
          <select id="format" value={format} onChange={event => setFormat(event.target.value)}>
            <option value="jsonl">JSONL · training</option>
            <option value="json">JSON</option>
            <option value="sql">SQL</option>
            <option value="wiki">Wiki Markdown</option>
          </select>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await api("/api/export", {
                  method: "POST",
                  body: JSON.stringify({ format, includeText: true }),
                });
                setExportURL(`/api/exports/${result.id}`);
                setStatus(`${result.documents} documents exportés.`);
              })
            }
          >
            Exporter
          </button>
          {exportURL && (
            <a href={exportURL} download>
              Télécharger le dataset
            </a>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const publication = await api("/api/publish", { method: "POST" });
                setExportURL("https://dist.aphrody.app/bun-video/manifest.json");
                setStatus(`${publication.assets.length} fichiers publiés et vérifiés sur R2.`);
              })
            }
          >
            Publier sur R2
          </button>
        </div>
        <div>
          <h2>Rendre avec Remotion / HyperFrames</h2>
          <label htmlFor="jobs">Plan de tâches JSON</label>
          <textarea
            id="jobs"
            rows={5}
            value={jobs}
            onChange={event => setJobs(event.target.value)}
            spellCheck={false}
          />
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await api("/api/jobs", { method: "POST", body: jobs });
                setStatus(`${result.accepted} tâches enregistrées.`);
                setTable("jobs");
              })
            }
          >
            Lancer les workers
          </button>
        </div>
      </section>
      <p className="status" role="status" aria-live="polite">
        {busy ? "Opération en cours…" : status}
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
