# Player API fact check

Checked on 2026-10-11 against installed packages, the package manifest and Context7
primary-source documentation. Context7 returned no exact version selectors for these
libraries. Installed declarations and manifests therefore determine version-specific
signatures; development/master documentation supplies supporting context only.

| Package           | Installed version        | Verified boundary                                                                                                               |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `bitmovin-player` | 8.279.0                  | Official Bitmovin Web SDK, browser DOM required; integration and bundling are not a native decoder rewrite.                     |
| `dashjs`          | 5.2.1                    | Browser MPEG-DASH player with MSE/EME; modern ESM import and UMD browser asset are separate export targets.                     |
| `hls.js`          | 1.7.4                    | Browser HLS/MSE player; the SDK lifecycle adapter accepts its constructor, config and worker.                                   |
| `fast-xml-parser` | 5.11.2                   | Native Bun XML inspection uses its published ESM parser and validator.                                                          |
| `crunchyroll.js`  | 1.1.1 migration baseline | Community MIT client API migrated to fetch; not an official Crunchyroll SDK or proof of current service endpoint compatibility. |

## API findings

`dash.ts` correctly defers `import("dashjs")` until a browser media element is
available. Installed `index.d.ts` confirms `initialize(view?, source?, autoplay?,
startTime?)`, `updateSettings`, `setProtectionData` and `addRequestInterceptor`.
The [official ESM example](https://github.com/Dash-Industry-Forum/dash.js/blob/development/samples/builds/esm-browserlist.html)
uses the named `MediaPlayer` export. Installed exports map imports to
`dist/modern/esm/dash.all.min.js` and browser scripts to
`dist/modern/umd/dash.all.min.js`; the asset-path conversion follows that layout.
The [official interceptor documentation](https://github.com/Dash-Industry-Forum/dash.js/blob/development/docs/site/pages/usage/network-interceptor.md)
returns a Promise of the request. Callers must preserve that asynchronous contract;
the wrapper's types inherit it. The lifecycle's synchronous beforeStart registration
and teardown through `reset()` are distinct from waiting for playback readiness.
Protection data merely configures authorized EME license acquisition and does not
establish that a browser, account or service will authorize playback.

The HLS adapter registers listeners before attachment/source loading and destroys
the instance on startup failure or explicit teardown. These operations match the
[official HLS API](https://github.com/video-dev/hls.js/blob/master/docs/API.md).
Its explicit same-origin worker requirement is a local integration policy; it must
not be described as a universal requirement of every HLS.js distribution. HLS.js
browser capability and worker behavior still require a real browser test.

Bitmovin's installed entry exports named and default `Player`; the wrapper's named
constructor is supported. Installed PlayerAPI declares asynchronous `load()` and
`destroy()`. Applications must load a source and await destruction where completion
matters. Installed LocationConfig confirms `ui`, `ui_css` and `serviceworker` URL
fields used by the browser asset helper. The [official Web v8 getting-started documentation](https://developer.bitmovin.com/playback/docs/getting-started-web)
requires a player license key. `createBitmovinPlayer` receives caller configuration;
it does not supply a license or reuse Crunchyroll's application configuration.
Context7 also returns Player Web X examples; their v10 factory/source API is not the
installed v8 constructor API and must not be applied to this integration.

Installed fast-xml-parser declarations confirm `ignoreAttributes`, `removeNSPrefix`,
`processEntities`, `parseTagValue` and `parseAttributeValue`. The inspector retains
attributes and namespace prefixes, disables entity processing and rejects DTD/entity
declarations before parsing. `XMLValidator.validate()` checks XML syntax, not the DASH
XSD or playback validity. The installed v5.11.2 validator remains available but is
marked deprecated in favor of `fast-xml-validator`; this is an upgrade consideration,
not a missing dependency or a reason to install another package for this test.
[Primary parser documentation](https://github.com/NaturalIntelligence/fast-xml-parser/blob/master/_autodocs/api-reference/XMLValidator.md)
corroborates the return contract.

## Provenance and limits

Installed manifests and notices identify dash.js as BSD-3-Clause, HLS.js as
Apache-2.0 and fast-xml-parser as MIT. The original Crunchyroll client is MIT,
copyright 2022 Mssjim; its retained notice is in `crunchyroll-migration.md`.
Bitmovin's installed package has no manifest license field and no source repository
URL; its `THIRD_PARTY_NOTICES` covers third-party components and does not establish
an open-source license for the SDK. Preserve its notices and applicable commercial
terms when distributing its assets; do not relabel the SDK as our Rust/Bun source.

Context7's `crunchyroll.js` resolution yielded a different project,
`/ffrostfall/crunchyroll`, not the installed Mssjim client. That result was rejected
as migration evidence. Export coverage and defaults are based on the installed
v1.1.1 source inspected during migration, with intentional safer authentication
differences documented separately. No live authentication, DRM license request,
credential transfer, browser playback or registry publication was performed by this
fact check.
