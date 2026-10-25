import { loadHarCapture } from "./har";

export interface CrunchyrollHarMap {
  hosts: Record<string, number>;
  cdn: string[];
  apiHosts: Array<{ host: string; count: number }>;
  manifests: Array<{ host: string; kind: string; representations: number; encrypted: boolean }>;
  jsonResponses: number;
  replayableResources: number;
}

const ID = /\/[0-9a-f]{8}-[0-9a-f-]{27}|\/[A-Z0-9]{8,}(?=\/|$)|\/\d{4,}(?=\/|$)/gi;

/** Normalises ids in a Crunchyroll path so endpoints group into stable routes. */
export function normalizeCrunchyrollPath(path: string): string {
  return path.replace(ID, "/:id");
}

/** Maps Crunchyroll hosts, CDN hosts and manifests from a HAR capture. */
export async function mapCrunchyrollHar(absolutePath: string): Promise<CrunchyrollHarMap> {
  const { summary } = await loadHarCapture(absolutePath);
  const crunchyHosts = Object.entries(summary.hosts)
    .filter(([host]) => /(^|\.)crunchyroll(cdn)?\.com$/.test(host))
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
  return {
    hosts: summary.hosts,
    cdn: Object.keys(summary.hosts).filter(host => host.endsWith("crunchyrollcdn.com")),
    apiHosts: crunchyHosts,
    manifests: summary.manifests.map(manifest => ({
      host: manifest.host,
      kind: manifest.kind,
      representations:
        manifest.metadata.kind === "dash" ? manifest.metadata.representations.length : manifest.metadata.variantCount,
      encrypted: manifest.metadata.encrypted,
    })),
    jsonResponses: summary.jsonResponses,
    replayableResources: summary.replayableResourceCount,
  };
}
