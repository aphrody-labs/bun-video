// SPDX-License-Identifier: Apache-2.0
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { VideoStudio, type StudioAsset } from "../studio";

function App() {
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch("/api/video/library", { cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ assets: StudioAsset[] }>;
      })
      .then(body => setAssets(body.assets))
      .catch(() => setError("Bibliothèque vidéo indisponible."));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  return <VideoStudio assets={assets} storageKey="bun-video-web-app" />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
