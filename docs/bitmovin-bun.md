# Bitmovin through Bun

`@aphrody/bun-video/bitmovin` integrates the installed official `bitmovin-player` 8.279.0 distribution. Bun owns installation and browser bundling; the proprietary player remains unchanged. Its package notices and licensing requirements still apply. This is a toolchain migration, not a rewrite of the player into a server media engine.

The server can import the adapter safely. `loadBitmovinPlayer()` and `createBitmovinPlayer()` defer the browser package import and reject without a DOM. No browser globals are fabricated.

```ts
// Run the build step in Bun.
import { buildBitmovinBrowser } from "@aphrody/bun-video/bitmovin";
const build = await buildBitmovinBrowser({
  outdir: "C:/project/public/player",
  assetBaseURL: "https://your-domain.example/player/",
});
// Persist build.location as public browser configuration.
```

The output directory contains `bitmovin-bun.js`, unchanged root JavaScript/CSS assets (including the service worker), and `THIRD_PARTY_NOTICES`. Without `outdir`, the build returns in-memory bundle artifacts and source asset files for the caller to serve. Serve the assets at `assetBaseURL` and pass the returned `location` to the player configuration. Browser service workers require a secure context (or localhost), compatible same-origin scope, and appropriate HTTP headers; the build does not register them.

```ts
// Browser application, or import from the generated bitmovin-bun.js module.
import { createBitmovinPlayer } from "@aphrody/bun-video/bitmovin";
const player = await createBitmovinPlayer(document.getElementById("player")!, {
  key: yourOwnBitmovinLicenseKey,
  location: yourPublishedBuildLocation,
});
await player.load({ hls: yourAuthorizedManifestURL });
```

The browser retains decoding, MSE, EME/CDM and DRM/license processing. A Crunchyroll page's player license/configuration does not grant a license to an independent application. Playback needs the caller's valid Bitmovin account key, allowed domain, authorized source and any required DRM configuration. Build tests qualify package resolution, server import isolation and generated assets only; they do not qualify licensed playback, browser worker registration, or Crunchyroll access.

The installed package declarations are the version-matched API authority. Official references: [Player configuration](https://cdn.bitmovin.com/player/web/8/docs/interfaces/core_config.playerconfig.html), [Web Player API](https://cdn.bitmovin.com/player/web/8/docs/index.html), and [official build samples](https://github.com/bitmovin/bitmovin-player-web-samples). Online references can reflect a different patch version; local 8.279.0 declarations govern this adapter.
