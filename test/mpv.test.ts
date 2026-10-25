import { describe, expect, test } from "bun:test";
import { MpvClient, mpvABI, mpvLibraryPath } from "../src/mpv";

describe.skipIf(!process.env.BUN_VIDEO_MEDIA_DIR && !process.env.BUN_VIDEO_MPV_LIBRARY)("native libmpv", () => {
  test("correlates asynchronous commands without losing 64-bit request identities", () => {
    using player = MpvClient.open({
      libraryPath: process.env.BUN_VIDEO_MPV_LIBRARY ?? mpvLibraryPath(process.env.BUN_VIDEO_MEDIA_DIR),
      options: { vo: "null", ao: "null", idle: "yes", config: "no" },
    });
    const identity = 0xfedcba9876543210n;
    player.commandAsync(identity, "set", "pause", "yes");
    const deadline = performance.now() + 1000;
    let reply;
    while (performance.now() < deadline) {
      const event = player.nextEvent(0.01);
      if (event.name === "command-reply" && event.replyUserdata === identity) {
        reply = event;
        break;
      }
    }
    expect(reply).toEqual({ id: 5, name: "command-reply", error: 0, replyUserdata: identity });
    expect(player.getProperty("pause")).toBe("yes");
    expect(() => player.commandAsync(-1n, "stop")).toThrow("unsigned 64-bit bigint");
    expect(() => player.commandAsync(1n << 64n, "stop")).toThrow("unsigned 64-bit bigint");
    expect(() => player.commandAsync(0n)).toThrow("at least one argument");
    expect(() => player.commandAsync(0n, "stop\0")).toThrow("NUL");
    player.close();
    expect(() => player.commandAsync(0n, "stop")).toThrow("mpv client is closed");
  });

  test("loads the client, render and custom-stream APIs from the same artifact", () => {
    using player = MpvClient.open({
      libraryPath: process.env.BUN_VIDEO_MPV_LIBRARY ?? mpvLibraryPath(process.env.BUN_VIDEO_MEDIA_DIR),
      options: { vo: "null", ao: "null", "idle": "yes", "config": "no" },
    });
    for (const name of Object.keys(mpvABI)) {
      expect(typeof (player.symbols as Record<string, unknown>)[name]).toBe("function");
    }
    expect(player.pointer).toBeGreaterThan(0);
    expect(player.getProperty("idle-active")).toBe("yes");
    const events = [];
    for (let index = 0; index < 64; index++) {
      const event = player.nextEvent();
      events.push(event);
      if (event.id === 0) break;
    }
    const none = events.at(-1)!;
    expect(none).toEqual({ id: 0, name: "none", error: 0, replyUserdata: 0n });
    player.nextEvent();
    expect(none).toEqual({ id: 0, name: "none", error: 0, replyUserdata: 0n });
    expect(() => player.nextEvent(-1)).toThrow("mpv timeout");
    expect(() => player.nextEvent(Number.NaN)).toThrow("mpv timeout");
    player.close();
    expect(() => player.pointer).toThrow("mpv client is closed");
    expect(() => player.symbols).toThrow("mpv client is closed");
    expect(() => player.nextEvent()).toThrow("mpv client is closed");
  });
});
