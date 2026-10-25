// Extraction des couches (pile de rendu) et des feuilles de style d'une page déjà rendue.
// Entrée : un objet Bun.WebView (ou tout objet exposant evaluate()) sur une page autorisée.

export interface LayerEntry {
  tag: string;
  id?: string;
  className?: string;
  position: string;
  zIndex: string;
  opacity: string;
  transform?: string;
  stackingContext: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PageLayerReport {
  title: string;
  stylesheets: string[];
  inlineStyleBlocks: number;
  layers: LayerEntry[];
}

export const LAYER_SCRIPT = `(() => {
  const isStacking = s => s.position !== 'static' && s.zIndex !== 'auto'
    || s.opacity !== '1' || (s.transform && s.transform !== 'none')
    || s.position === 'fixed' || s.position === 'sticky';
  const layers = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (!isStacking(s)) continue;
    const r = el.getBoundingClientRect();
    layers.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join(' ') || undefined : undefined,
      position: s.position,
      zIndex: s.zIndex,
      opacity: s.opacity,
      transform: s.transform === 'none' ? undefined : s.transform,
      stackingContext: s.position !== 'static' && s.zIndex !== 'auto',
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    });
  }
  return JSON.stringify({
    title: document.title,
    stylesheets: [...document.querySelectorAll('link[rel~="stylesheet"]')].map(l => l.href),
    inlineStyleBlocks: document.querySelectorAll('style').length,
    layers,
  });
})()`;

/** Lit la pile de couches d'une page déjà rendue, sans navigation ni contournement. */
export async function readPageLayers(view: { evaluate(script: string): Promise<unknown> }): Promise<PageLayerReport> {
  const raw = await view.evaluate(LAYER_SCRIPT);
  if (typeof raw !== "string") throw new TypeError("layer script returned no report");
  return JSON.parse(raw) as PageLayerReport;
}
