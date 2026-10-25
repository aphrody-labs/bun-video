#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { createVideoWebApp } from "./web-app";

const port = Number(Bun.env.BUN_VIDEO_PORT ?? 8787);
const hostname = Bun.env.BUN_VIDEO_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BUN_VIDEO_PORT must be 1..65535");
const mediaRoot = resolve(Bun.env.BUN_VIDEO_MEDIA_ROOT ?? "var/media");
const hlsLab = Bun.env.BUN_VIDEO_HLS === "1";
const app = createVideoWebApp({
  mediaRoot,
  showcaseRoot: Bun.env.BUN_VIDEO_SHOWCASE_ROOT,
  publicMode: Bun.env.BUN_VIDEO_PUBLIC_MODE === "1",
  trustCloudflareAccessHeaders: Bun.env.BUN_VIDEO_TRUST_CF_ACCESS === "1",
  publicOrigin: Bun.env.BUN_VIDEO_PUBLIC_ORIGIN,
  hlsLab,
  hlsCookieSecret: Bun.env.BUN_VIDEO_COOKIE_SECRET,
  youtube: Bun.env.BUN_VIDEO_YOUTUBE_API_KEY
    ? {
        apiKey: Bun.env.BUN_VIDEO_YOUTUBE_API_KEY,
        trustCloudflareIdentity: Bun.env.BUN_VIDEO_TRUST_CF_IP === "1",
      }
    : undefined,
});
const server = Bun.serve({ hostname, port, fetch: app.fetch });
console.log(JSON.stringify({ service: "bun-video", url: server.url.href, mediaRoot }));
