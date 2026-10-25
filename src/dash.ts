// SPDX-License-Identifier: Apache-2.0
import type { MediaPlayerClass, ProtectionDataSet } from "dashjs";

export interface DashPlaybackInstance {
  on: MediaPlayerClass["on"];
  off: MediaPlayerClass["off"];
  initialize(video?: HTMLMediaElement, source?: string, autoplay?: boolean, startTime?: number | string): void;
  updateSettings(settings: Parameters<MediaPlayerClass["updateSettings"]>[0]): void;
  setProtectionData(data: ProtectionDataSet): void;
  addRequestInterceptor(interceptor: Parameters<MediaPlayerClass["addRequestInterceptor"]>[0]): void;
  reset(): void;
}

export interface DashPlaybackOptions<Instance extends DashPlaybackInstance = DashPlaybackInstance> {
  src: string;
  autoplay?: boolean;
  startTime?: number | string;
  settings?: Parameters<MediaPlayerClass["updateSettings"]>[0];
  protectionData?: ProtectionDataSet;
  requestInterceptor?: Parameters<MediaPlayerClass["addRequestInterceptor"]>[0];
  beforeStart?: (instance: Instance) => void;
  createPlayer?: () => Instance;
}

function sourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DASH source must be an absolute HTTP(S) URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("DASH source must use HTTP(S) without embedded credentials.");
  return url.href;
}

export async function attachDashPlayback<Instance extends DashPlaybackInstance = DashPlaybackInstance>(
  video: HTMLMediaElement,
  options: DashPlaybackOptions<Instance>,
): Promise<{ instance: Instance; destroy(): void }> {
  const src = sourceUrl(options.src);
  let instance: Instance;
  if (options.createPlayer) instance = options.createPlayer();
  else {
    const view = video.ownerDocument?.defaultView;
    if (!view || !(video instanceof view.HTMLMediaElement))
      throw new Error("DASH playback requires a browser media element or an explicit player factory.");
    const { MediaPlayer } = await import("dashjs");
    instance = MediaPlayer().create() as unknown as Instance;
  }
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    instance.reset();
  };
  try {
    if (options.settings) instance.updateSettings(options.settings);
    if (options.protectionData) instance.setProtectionData(options.protectionData);
    if (options.requestInterceptor) instance.addRequestInterceptor(options.requestInterceptor);
    const prepared: unknown = options.beforeStart?.(instance);
    if (prepared && typeof (prepared as { then?: unknown }).then === "function")
      throw new Error("DASH beforeStart must register listeners synchronously.");
    instance.initialize(video, src, options.autoplay ?? false, options.startTime);
  } catch (error) {
    try {
      destroy();
    } catch {
      /* Preserve the original startup failure. */
    }
    throw error;
  }
  return { instance, destroy };
}

/** Serve this installed UMD file with Bun.file; resolving it never imports the browser player. */
export function getDashBrowserAssetPath(): string {
  return Bun.resolveSync("dashjs", import.meta.dir).replace(/[\\/](?:esm|umd)[\\/][^\\/]+$/, "/umd/dash.all.min.js");
}

type XmlNode = Record<string, unknown>;
const nodes = (value: unknown): XmlNode[] =>
  (Array.isArray(value) ? value : [value]).filter((node): node is XmlNode => !!node && typeof node === "object");
const children = (node: XmlNode, localName: string): XmlNode[] =>
  Object.entries(node)
    .filter(([name]) => !name.startsWith("@") && name.split(":").at(-1) === localName)
    .flatMap(([, value]) => nodes(value));
const attribute = (node: XmlNode, name: string): string | undefined => {
  const value = node[`@${name}`];
  return typeof value === "string" ? value : undefined;
};
const numeric = (value: string | undefined): number | undefined => {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};
const safeCodecs = (value: string | undefined) => (value && /^[\w., -]{1,100}$/.test(value) ? value : undefined);
const protectionSystem = (node: XmlNode): string => {
  const scheme = attribute(node, "schemeIdUri")?.toLowerCase();
  if (scheme === "urn:mpeg:dash:mp4protection:2011") return "CommonEncryption";
  if (scheme === "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed") return "Widevine";
  if (scheme === "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95") return "PlayReady";
  return "OtherProtection";
};

export function inspectDashManifest(xml: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new Error("DASH manifest must not contain DTD or entity declarations.");
  let parsed: XmlNode;
  try {
    parsed = Bun.XML.parse(xml) as XmlNode;
  } catch {
    throw new Error("Invalid DASH manifest XML.");
  }
  const roots = Object.entries(parsed).filter(([name]) => name.split(":").at(-1) === "MPD");
  if (roots.length !== 1) throw new Error("DASH manifest must have an MPD root.");
  const mpd = nodes(roots[0]![1])[0];
  if (!mpd) throw new Error("Invalid DASH MPD root.");
  const rootName = roots[0]![0];
  const prefix = rootName.includes(":") ? rootName.split(":")[0] : undefined;
  const namespace = attribute(mpd, prefix ? `xmlns:${prefix}` : "xmlns");
  if (namespace !== "urn:mpeg:dash:schema:mpd:2011") throw new Error("DASH manifest must declare the MPD namespace.");
  const systems = new Set<string>();
  let contentProtectionCount = 0,
    baseUrlCount = 0,
    segmentTemplateCount = 0;
  const visit = (node: XmlNode) => {
    for (const [name, value] of Object.entries(node)) {
      if (name.startsWith("@") || name === "#text") continue;
      const local = name.split(":").at(-1);
      if (local === "BaseURL") baseUrlCount += Array.isArray(value) ? value.length : 1;
      if (local === "SegmentTemplate") segmentTemplateCount += nodes(value).length;
      if (local === "ContentProtection")
        for (const protection of nodes(value)) {
          contentProtectionCount++;
          systems.add(protectionSystem(protection));
        }
      for (const child of nodes(value)) visit(child);
    }
  };
  visit(mpd);
  const periods = children(mpd, "Period");
  const representations = periods.flatMap(period =>
    children(period, "AdaptationSet").flatMap(adaptation =>
      children(adaptation, "Representation").map(representation => ({
        width: numeric(attribute(representation, "width") ?? attribute(adaptation, "width")),
        height: numeric(attribute(representation, "height") ?? attribute(adaptation, "height")),
        bandwidth: numeric(attribute(representation, "bandwidth")),
        codecs: safeCodecs(attribute(representation, "codecs") ?? attribute(adaptation, "codecs")),
      })),
    ),
  );
  const duration = attribute(mpd, "mediaPresentationDuration");
  return {
    kind: "dash" as const,
    namespace,
    type: attribute(mpd, "type") === "dynamic" ? ("dynamic" as const) : ("static" as const),
    duration: duration && /^P[\d.YMDTHS]+$/.test(duration) ? duration : undefined,
    periodCount: periods.length,
    representations,
    baseUrlCount,
    segmentTemplateCount,
    encrypted: contentProtectionCount > 0,
    contentProtectionSystems: [...systems].sort(),
  };
}
