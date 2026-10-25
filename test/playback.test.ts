// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, test } from "bun:test";
import type Hls from "hls.js";
import { createVideoPlayback, createVideoRecovery, isHlsSource, type VideoPlaybackState } from "../src/playback";

class VideoFixture extends EventTarget {
  ownerDocument = {
    defaultView: { HTMLVideoElement: VideoFixture },
    URL: "https://site.test/watch",
    baseURI: "https://site.test/watch",
  };
  src = "";
  error: MediaError | null = null;
  nativeHls = false;
  paused = 0;
  unloaded = 0;
  canPlayType() {
    return this.nativeHls ? "probably" : "";
  }
  pause() {
    this.paused++;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {
    this.unloaded++;
  }
}
class DecoderFixture {
  static supported = true;
  static instances: DecoderFixture[] = [];
  static Events = {
    MANIFEST_PARSED: "manifest",
    LEVELS_UPDATED: "levels",
    LEVEL_SWITCHED: "quality",
    AUDIO_TRACKS_UPDATED: "audio",
    AUDIO_TRACK_SWITCHED: "track",
    ERROR: "error",
  };
  static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
  static isSupported() {
    return this.supported;
  }
  listeners = new Map<string, ((event: string, data: Record<string, unknown>) => void)[]>();
  levels = [
    { height: 720, bitrate: 1000 },
    { height: 1080, bitrate: 2000 },
  ];
  audioTracks = [
    { name: "French", lang: "fr" },
    { name: "", lang: "ja" },
  ];
  audioTrack = 0;
  autoLevelEnabled = true;
  selected = -1;
  source = "";
  destroyed = 0;
  networkRecoveries = 0;
  mediaRecoveries = 0;
  get currentLevel() {
    return this.selected;
  }
  set currentLevel(value: number) {
    this.selected = value;
    this.autoLevelEnabled = value === -1;
  }
  constructor(readonly config: { workerPath?: string; enableWorker?: boolean }) {
    DecoderFixture.instances.push(this);
  }
  attachMedia() {}
  loadSource(source: string) {
    this.source = source;
    this.emit("manifest");
  }
  on(event: string, callback: (event: string, data: Record<string, unknown>) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }
  emit(event: string, data: Record<string, unknown> = {}) {
    for (const callback of this.listeners.get(event) ?? []) callback(event, data);
  }
  startLoad() {
    this.networkRecoveries++;
  }
  recoverMediaError() {
    this.mediaRecoveries++;
  }
  destroy() {
    this.destroyed++;
    this.listeners.clear();
  }
}
const decoder = DecoderFixture as unknown as typeof Hls;
const media = () => new VideoFixture() as unknown as HTMLVideoElement;
const loadDecoder = async () => decoder;
const config = { enableWorker: true, workerPath: "/assets/bun-video/hls.worker.js" };
beforeEach(() => {
  DecoderFixture.instances = [];
  DecoderFixture.supported = true;
});

test("native source status comes from media events, cleanup is idempotent", async () => {
  const video = media();
  const observed: VideoPlaybackState[] = [];
  const controller = createVideoPlayback(video, { src: "/episode.mp4", onState: state => observed.push(state) });
  expect(await controller.attached).toBe(true);
  expect(controller.state.backend).toBe("native");
  expect(controller.state.status).toBe("loading");
  video.dispatchEvent(new Event("playing"));
  expect(controller.state.status).toBe("ready");
  expect(observed.at(-1)?.source).toBe("/episode.mp4");
  controller.destroy();
  controller.destroy();
  expect(video.src).toBe("");
  expect((video as unknown as VideoFixture).paused).toBe(1);
  expect((video as unknown as VideoFixture).unloaded).toBe(1);
});

test("a stale native error after source reset cannot fail its successor", async () => {
  const video = media();
  let failures = 0;
  const controller = createVideoPlayback(video, { src: "/episode.mp4", onError: () => failures++ });
  await controller.attached;
  video.dispatchEvent(new Event("error"));
  expect(controller.state.status).toBe("loading");
  expect(failures).toBe(0);
  (video as unknown as VideoFixture).error = { code: 2, message: "Network unavailable" } as MediaError;
  video.dispatchEvent(new Event("error"));
  expect(controller.state.status).toBe("failed");
  expect(failures).toBe(1);
  controller.destroy();
});

test("HLS metadata, quality/audio selection, and worker origin use the qualified decoder", async () => {
  const controller = createVideoPlayback(media(), { src: "/episode.m3u8", config, loadDecoder });
  expect(await controller.attached).toBe(true);
  const active = DecoderFixture.instances[0]!;
  expect(active.config.workerPath).toBe("https://site.test/assets/bun-video/hls.worker.js");
  expect(controller.state.levels.map(level => level.height)).toEqual([720, 1080]);
  expect(controller.state.audioTracks.map(track => track.name)).toEqual(["French", "ja"]);
  expect(controller.selectQuality(1)).toBe(true);
  expect(active.currentLevel).toBe(1);
  expect(controller.state.quality).toBe(1);
  expect(controller.selectQuality(-1)).toBe(true);
  expect(controller.state.quality).toBe(-1);
  expect(controller.selectAudioTrack(1)).toBe(true);
  expect(active.audioTrack).toBe(1);
  for (const value of [NaN, Infinity, -2, 2, 0.5]) expect(controller.selectQuality(value)).toBe(false);
  for (const value of [NaN, Infinity, -1, 2, 0.5]) expect(controller.selectAudioTrack(value)).toBe(false);
  controller.destroy();
  expect(active.destroyed).toBe(1);
  expect(controller.selectQuality(0)).toBe(false);
});

test("failed sources exhaust independent network/media budgets and report once", async () => {
  const errors: unknown[] = [];
  const controller = createVideoPlayback(media(), {
    src: "/episode.m3u8",
    config,
    loadDecoder,
    onError: error => errors.push(error),
  });
  await controller.attached;
  const active = DecoderFixture.instances[0]!;
  active.emit("error", { fatal: false, type: "network" });
  expect(active.networkRecoveries).toBe(0);
  active.emit("error", { fatal: true, type: "media" });
  expect(active.mediaRecoveries).toBe(1);
  for (let i = 0; i < 3; i++) active.emit("error", { fatal: true, type: "network", details: "fragment failed" });
  expect(active.networkRecoveries).toBe(2);
  expect(controller.state.status).toBe("failed");
  expect(active.destroyed).toBe(1);
  expect(errors).toHaveLength(1);
  active.emit("manifest");
  expect(controller.state.status).toBe("failed");
  controller.destroy();
  expect(active.destroyed).toBe(1);
});

test("manifest failure without levels cannot recover by startLoad", async () => {
  const controller = createVideoPlayback(media(), { src: "/episode.m3u8", config, loadDecoder });
  await controller.attached;
  const active = DecoderFixture.instances[0]!;
  active.levels = [];
  active.emit("error", { fatal: true, type: "network", details: "manifest unavailable" });
  expect(controller.state.status).toBe("failed");
  expect(active.networkRecoveries).toBe(0);
  expect(active.destroyed).toBe(1);
  controller.destroy();
});

test("late decoder loading and stale controllers cannot clear the successor source", async () => {
  const video = media();
  const pending = Promise.withResolvers<typeof Hls>();
  const previous = createVideoPlayback(video, { src: "/previous.m3u8", config, loadDecoder: () => pending.promise });
  const current = createVideoPlayback(video, { src: "/current.mp4" });
  expect(await current.attached).toBe(true);
  previous.destroy();
  expect(await previous.attached).toBe(false);
  pending.resolve(decoder);
  expect(await previous.attached).toBe(false);
  expect(DecoderFixture.instances).toHaveLength(0);
  expect(video.src).toBe("https://site.test/current.mp4");
  video.dispatchEvent(new Event("playing"));
  expect(current.state.status).toBe("ready");
  current.destroy();
});

test("native HLS fallback creates no worker; an unsupported browser reports failure", async () => {
  DecoderFixture.supported = false;
  const video = media();
  (video as unknown as VideoFixture).nativeHls = true;
  const native = createVideoPlayback(video, { src: "/episode.m3u8", loadDecoder });
  expect(await native.attached).toBe(true);
  expect(native.state.backend).toBe("native");
  expect(DecoderFixture.instances).toHaveLength(0);
  native.destroy();
  const unsupported = createVideoPlayback(media(), { src: "/episode.m3u8", loadDecoder });
  expect(await unsupported.attached).toBe(false);
  expect(unsupported.state.status).toBe("failed");
  unsupported.destroy();
});

test("unsafe source and foreign worker are rejected before decoder construction", async () => {
  for (const src of ["", "javascript:alert(1)", "https://user:secret@site.test/episode.mp4"]) {
    const controller = createVideoPlayback(media(), { src });
    expect(await controller.attached).toBe(false);
    expect(controller.state.status).toBe("failed");
    controller.destroy();
  }
  const controller = createVideoPlayback(media(), {
    src: "/episode.m3u8",
    loadDecoder,
    config: { workerPath: "https://other.test/worker.js", enableWorker: true },
  });
  expect(await controller.attached).toBe(false);
  expect(DecoderFixture.instances).toHaveLength(0);
  controller.destroy();
});

test("recovery is per source and HLS query/fragment suffixes are preserved", () => {
  const recover = createVideoRecovery();
  expect([recover("network"), recover("network"), recover("network")]).toEqual(["network", "network", "fail"]);
  expect([recover("media"), recover("media")]).toEqual(["media", "fail"]);
  expect(createVideoRecovery()("network")).toBe("network");
  expect(isHlsSource("/episode.m3u8?version=public#fragment")).toBe(true);
  expect(isHlsSource("/episode.mp4?title=playlist.m3u8")).toBe(false);
});
