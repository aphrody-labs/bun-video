# Bun video protocol integration

The package retains its existing Remotion and HyperFrames entry point. Protocol
entry points are explicit so importing a server API does not initialize a player:

| Import                              | Behavior                                                             |
| ----------------------------------- | -------------------------------------------------------------------- |
| `@aphrody/bun-video/hls`            | Fork SDK lifecycle plus the pinned HLS.js browser decoder            |
| `@aphrody/bun-video/playback`       | Browser media lifetime, bounded recovery, qualities and audio tracks |
| `@aphrody/bun-video/dash` or `/mpd` | MPD inspection and dash.js browser lifecycle                         |
| `@aphrody/bun-video/har`            | Private HAR inspection and captured response replay                  |
| `@aphrody/bun-video/bitmovin`       | Official player loading and Bun browser bundling                     |
| `@aphrody/bun-video/crunchyroll`    | Migrated native fetch client                                         |
| `@aphrody/bun-video/oauth`          | Owner-configured authorization-code PKCE, refresh and revocation     |
| `@aphrody/bun-video/secrets`        | Native OS JSON credential storage with bounded Windows entries       |

HLS reuses `@aphrody/bun-runtime-sdk/video/hls`, including synchronous listener
registration, URL validation, explicit worker origin checks and cleanup. The
decoder is pinned `hls.js` 1.7.3; no separately owned decoder fork was found in
this checkout. `attachVideoHlsPlayback` loads that decoder in the browser and
defaults workers off; explicit worker configuration remains supported. The SDK
dependency is 1.4.5: 1.4.4 does not publish the `video/hls` export.

`createVideoPlayback(video, { src, config, onState, onError })` owns one browser
media element. Its `attached` promise confirms source attachment only; readiness
comes from native media events. `destroy()` cancels late decoder loading,
terminates its HLS instance and clears only its own media source. A new controller
disposes the previous owner automatically. Recovery is limited to two network
retries and one media recovery per source; a manifest without levels fails
immediately. Qualities and audio tracks come from the active decoder; indices are
validated before selection. Application controls, translations and saved progress
remain with the consumer.

`getHlsPublicAssets()` identifies the pinned worker and Apache/Dailymotion license
for explicit same-origin staging. Browser playback requires a browser media
element and uses HTML media/MSE, while native `Bun.Video` frame extraction uses the
optional FilmCraft provider. Neither a compiled CLI nor this adapter makes a
`Bun.Video` global available in a browser.

MPD parsing, HAR loading, fetch, bundling and loopback serving run in Bun.
Media decoding and DRM run in the browser through its media element, MSE and EME.
These additions do not add a server decoder or duplicate the existing Rust HLS
extractor. Bitmovin remains the official licensed browser distribution; its
implementation is not rewritten into a server player.

The supplied capture contains one encrypted DASH MPD and captured range responses.
Captured media can be inspected and replayed locally, but a capture does not grant
a reusable DRM license. The captured manifest's live request returned HTTP 401
on 2026-10-11. Current OAuth credentials and an authorized license configuration
are still required to qualify Crunchyroll playback. Local lifecycle and transport
tests do not establish live service compatibility.

Run from the checkout with `bun bd test ./packages/bun-video/test` and
`bun bd run ./scripts/aphrody/dash-lab.ts --check` or `--open`.
The [multilingual shortcuts](shortcuts.md) provide an MV3 extension and a Bun-served
local PWA shell; installation remains a separate Chrome gate. The launcher selects
the unique Google Chrome process and excludes concurrently running BunChromium
test browsers. Multiple Google Chrome roots still fail as ambiguous.
Active lab cookies are read from Bun.secrets and Windows Credential Manager;
the ignored checkout `cookie.json` is a link to a non-secret reference descriptor.
The original protected input remains available for rollback. See the
[native credential workflow](secrets.md). HAR files and signed manifests stay ignored.
Publication requires a separate authorized release with an audited artifact and
the relevant real playback gates. A source commit or prepared archive does not
prove publication or deployment.
