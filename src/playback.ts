// SPDX-License-Identifier: Apache-2.0
import type Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import { attachVideoHlsPlayback } from "./hls";

export type VideoPlaybackStatus = "loading" | "ready" | "recovering" | "failed";
export interface VideoPlaybackState {
  source: string;
  status: VideoPlaybackStatus;
  levels: { index: number; height: number; bitrate: number }[];
  quality: number;
  audioTracks: { index: number; name: string }[];
  audioTrack: number;
  backend: "native" | "hls" | null;
}
export interface VideoPlaybackOptions {
  src: string;
  type?: "native" | "hls";
  config?: Partial<HlsConfig>;
  onState?: (state: VideoPlaybackState) => void;
  onError?: (error: unknown) => void;
  /** Supply an already qualified decoder; the default loads Bun Video's pinned HLS dependency. */
  loadDecoder?: () => Promise<typeof Hls>;
}
export interface VideoPlayback {
  readonly state: VideoPlaybackState;
  /** Resolves after source attachment, not after media playback. */
  readonly attached: Promise<boolean>;
  selectQuality(index: number): boolean;
  selectAudioTrack(index: number): boolean;
  destroy(): void;
}

const owners = new WeakMap<HTMLVideoElement, VideoPlayback>();

export function createVideoRecovery() {
  let networkAttempts = 0;
  let mediaAttempts = 0;
  return (type: "network" | "media" | "other"): "network" | "media" | "fail" => {
    if (type === "network" && networkAttempts++ < 2) return "network";
    if (type === "media" && mediaAttempts++ < 1) return "media";
    return "fail";
  };
}

export function isHlsSource(source: string): boolean {
  try {
    const url = new URL(source, "https://relative.invalid");
    return /^https?:$/.test(url.protocol) && url.pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

export function createVideoPlayback(video: HTMLVideoElement, options: VideoPlaybackOptions): VideoPlayback {
  owners.get(video)?.destroy();
  let disposed = false;
  let failed = false;
  let instance: Hls | undefined;
  let releaseDecoder: (() => void) | undefined;
  let state: VideoPlaybackState = {
    source: options.src,
    status: "loading",
    levels: [],
    quality: -1,
    audioTracks: [],
    audioTrack: -1,
    backend: null,
  };
  const recovery = createVideoRecovery();
  const publish = (next: Partial<VideoPlaybackState>) => {
    if (disposed || failed) return;
    state = { ...state, ...next };
    options.onState?.(state);
  };
  const release = () => {
    const destroy = releaseDecoder;
    releaseDecoder = undefined;
    instance = undefined;
    destroy?.();
  };
  const fail = (error: unknown) => {
    if (disposed || failed) return;
    failed = true;
    state = { ...state, status: "failed" };
    release();
    try {
      options.onState?.(state);
    } finally {
      options.onError?.(error);
    }
  };
  const loading = () => publish({ status: "loading" });
  const ready = () => publish({ status: "ready" });
  const mediaError = () => {
    // Source replacement clears MediaError before queued events from the old source arrive.
    if (state.backend === "native" && video.error) fail(video.error);
  };
  const events = [
    ["loadstart", loading],
    ["waiting", loading],
    ["canplay", ready],
    ["playing", ready],
    ["error", mediaError],
  ] as const;
  const syncTracks = () => {
    if (!instance) return;
    publish({
      levels: instance.levels.map((level, index) => ({ index, height: level.height, bitrate: level.bitrate })),
      quality: instance.autoLevelEnabled ? -1 : instance.currentLevel,
      audioTracks: instance.audioTracks.map((track, index) => ({ index, name: track.name || track.lang || "" })),
      audioTrack: instance.audioTrack,
    });
  };
  const attach = async () => {
    try {
      const view = video.ownerDocument?.defaultView;
      if (!view || !(video instanceof view.HTMLVideoElement))
        throw new Error("Video playback requires a browser video element");
      const source = new URL(options.src, video.ownerDocument.baseURI);
      if (!options.src.trim() || !/^https?:$/.test(source.protocol) || source.username || source.password)
        throw new Error("Video sources must use HTTP(S) without embedded credentials");
      publish({ status: "loading" });
      if (disposed || failed) return false;
      if ((options.type ?? (isHlsSource(options.src) ? "hls" : "native")) === "native") {
        publish({ backend: "native" });
        if (disposed || failed) return false;
        video.src = source.href;
        return !failed;
      }
      const Decoder = await (options.loadDecoder?.() ?? import("hls.js").then(module => module.default));
      if (disposed || failed) return false;
      if (!Decoder.isSupported()) {
        if (!video.canPlayType("application/vnd.apple.mpegurl"))
          throw new Error("HLS playback is not supported by this browser");
        publish({ backend: "native" });
        if (disposed || failed) return false;
        video.src = source.href;
        return !failed;
      }
      publish({ backend: "hls" });
      if (disposed || failed) return false;
      const playback = await attachVideoHlsPlayback(video, {
        src: source.href,
        decoder: Decoder,
        config: { capLevelToPlayerSize: true, backBufferLength: 30, maxMaxBufferLength: 60, ...options.config },
        beforeStart(active) {
          instance = active;
          for (const event of [
            Decoder.Events.MANIFEST_PARSED,
            Decoder.Events.LEVELS_UPDATED,
            Decoder.Events.LEVEL_SWITCHED,
            Decoder.Events.AUDIO_TRACKS_UPDATED,
            Decoder.Events.AUDIO_TRACK_SWITCHED,
          ])
            active.on(event, syncTracks);
          active.on(Decoder.Events.ERROR, (_event, data) => {
            if (disposed || failed || !data.fatal) return;
            const type =
              data.type === Decoder.ErrorTypes.NETWORK_ERROR
                ? "network"
                : data.type === Decoder.ErrorTypes.MEDIA_ERROR
                  ? "media"
                  : "other";
            const action = type === "network" && active.levels.length === 0 ? "fail" : recovery(type);
            try {
              if (action === "network") {
                publish({ status: "recovering" });
                active.startLoad();
              } else if (action === "media") {
                publish({ status: "recovering" });
                active.recoverMediaError();
              } else fail(data.error ?? new Error(`HLS playback failed: ${data.details}`));
            } catch (error) {
              fail(error);
            }
          });
        },
      });
      releaseDecoder = playback.destroy;
      if (disposed || failed) {
        release();
        return false;
      }
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  let attached: Promise<boolean>;
  const stopped = Promise.withResolvers<boolean>();
  const controller: VideoPlayback = {
    get state() {
      return state;
    },
    get attached() {
      return attached;
    },
    selectQuality(index) {
      if (disposed || failed || !instance || !Number.isInteger(index) || index < -1 || index >= instance.levels.length)
        return false;
      instance.currentLevel = index;
      syncTracks();
      return true;
    },
    selectAudioTrack(index) {
      if (
        disposed ||
        failed ||
        !instance ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= instance.audioTracks.length
      )
        return false;
      instance.audioTrack = index;
      syncTracks();
      return true;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      stopped.resolve(false);
      for (const [event, listener] of events) video.removeEventListener(event, listener);
      release();
      if (owners.get(video) !== controller) return;
      owners.delete(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
  owners.set(video, controller);
  for (const [event, listener] of events) video.addEventListener(event, listener);
  attached = Promise.race([attach(), stopped.promise]);
  return controller;
}
