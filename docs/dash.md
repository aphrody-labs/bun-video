# DASH playback in Bun Video

`@aphrody/bun-video/dash` inspects MPEG DASH manifests in Bun and attaches the dash.js 5.2.1 browser player to a media element. XML parsing uses fast-xml-parser 5.11.2 with namespace prefixes preserved, entity processing disabled, DTD declarations rejected, and XML validation before inspection.

```ts
import { attachDashPlayback } from "@aphrody/bun-video/dash";

const playback = await attachDashPlayback(document.querySelector("video")!, {
  src: "https://media.example.test/manifest.mpd",
  beforeStart(player) {
    player.on("error", () => console.error("DASH playback error"));
  },
});
// Release the player when the component is removed.
playback.destroy();
```

Playback defaults to `autoplay: false`. `settings`, `startTime`, an optional `requestInterceptor`, and caller-provided `protectionData` are configured before initialization. `beforeStart` must execute synchronously. `createPlayer` can supply an already qualified browser factory or a synthetic player for lifecycle tests. Without that factory, dash.js is imported lazily only when a real browser media element exists. Startup errors reset the player while preserving the original exception; `destroy()` resets at most once.

`getDashBrowserAssetPath()` returns the installed browser UMD asset without importing its browser globals. A Bun server can serve `Bun.file(getDashBrowserAssetPath())` with the JavaScript content type; the page receives `dashjs.MediaPlayer` and can pass `createPlayer: () => dashjs.MediaPlayer().create()`. Preserve dash.js's BSD license when distributing its assets.

`inspectDashManifest(xml)` returns duration, period count, representation dimensions/codecs/bandwidth, base URL and segment template counts, and declared protection systems. It retains no source URLs, PSSH payloads, key IDs, license configuration or media bytes. Relative bases and templates remain the player's responsibility; inspection does not resolve or fetch them.

The supplied Crunchyroll capture contains DASH with Common Encryption, Widevine and PlayReady declarations. Successful parsing and synthetic lifecycle tests establish manifest handling and adapter behavior. They do not establish browser playback or licence acquisition. Encrypted playback requires a compatible browser CDM and the service's authorized license session; supply that runtime configuration through `protectionData`. Captured license bytes and account credentials are never treated as player configuration. This adapter does not decrypt media or implement Crunchyroll's account API.

The interceptor is installed before initialization and follows the [dash.js network interceptor contract](https://dashif.org/dash.js/pages/usage/network-interceptor.html). See the [dash.js player setup documentation](https://dashif.org/dash.js/pages/quickstart/setup.html) for browser requirements and the installed `dashjs/index.d.ts` for version-matched configuration types.
