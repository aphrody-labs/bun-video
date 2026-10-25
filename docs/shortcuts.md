# Bun extension and installable local shortcut

The canonical static applications are `assets/crunchyroll-extension` and `assets/crunchyroll-pwa` inside `@aphrody/bun-video`. They share the same eleven complete UI catalogs: English, French, Spanish, Portuguese, German, Italian, Arabic, Japanese, Korean, Hindi and Russian. Arabic uses RTL layout; language variants fall back to their base language and unknown languages to English. Language preferences stay in each local application. The official watch URL remains the supplied French episode page.

The extension uses Manifest V3 and an external module popup script with no permissions, host permissions, injected code or background process. Chrome’s built-in i18n localizes the manifest from `_locales`; the popup can switch languages independently. Install it from `chrome://extensions` using **Load unpacked** and the extension folder once local validation is complete. No automatic extension installation is claimed.

The PWA entry is `/pwa/`, with `index.html`, `app.js`, `styles.css`, `locales.js`, `manifest.webmanifest`, `sw.js` and real `icons/icon192.png`/`icon512.png`. Serve those files with Bun on a stable localhost origin. The manifest uses `/pwa/` for its ID, scope and start URL and defines standalone display. The install button waits for Chrome’s real install event. A manifest and icons establish installable application assets; actual Chrome installation must be separately observed.

From the installed package directory, start the Bun server:

```powershell
bun run ./src/apps/crunchyroll-shortcuts.ts --port 8000
```

Open `http://127.0.0.1:8000/pwa/`. Keep this origin stable for subsequent launches. `--check` validates the manifests and native browser-module availability on an ephemeral port; `--open` selects the existing active Chrome profile through the native launcher without restarting Chrome. It does not install the PWA or the extension. The server exposes only the listed static assets and GET/HEAD, binds to loopback, and stops on SIGINT/SIGTERM. A busy port fails without terminating another service.

The canonical server and Windows launcher are `src/apps/crunchyroll-shortcuts.ts` and `src/apps/crunchyroll-app.ts`; their exported `crunchyrollShortcutsMain` and `crunchyrollAppMain` functions support embedding. Asset paths resolve relative to the package, including from a standalone npm installation. The old `scripts/aphrody` entries are repository compatibility wrappers. In the Bun source checkout, use `bun bd -j2 run ./scripts/aphrody/crunchyroll-shortcuts.ts` to qualify the changed binary. The Windows shortcut targets the canonical launcher file, not a repository script outside the package.

Native OAuth is exported separately through `@aphrody/bun-video/oauth`; see [OAuth configuration and qualification](oauth.md). These shortcuts use the official site’s existing login. Creating an OAuth client requires authorized provider endpoints, a client ID and a registered callback; the local launcher does not invent those settings or turn a user account into an application registration.

The versioned service-worker cache contains only a strict local static-shell allowlist. External Crunchyroll pages, account/authentication, cookies and video streams are excluded. Cache cleanup is limited to this application’s prefix. Offline shell display and licensed video playback are separate capabilities.

These shortcuts preserve the real browser’s existing provider session by opening the official site normally. They do not transfer cookies into Bun, use DRM-license material, embed private HAR content or claim independent Bun decoding. The existing DASH lab qualifies Bun’s adapter and capture replay separately. Chrome UI automation was stopped by the host in this turn, so installation instructions are provided without fabricated installation evidence.

Qualification on the changed Bun 1.4.4 binary covers 40 tests across the shortcut, OAuth, live DASH and catalog modules, with scoped TypeScript and oxlint passing. Service-worker behavior is evaluated from the actual script in a VM with a browser Request fixture: this Bun binary reports `include` for all native Request credential modes, so the fixture explicitly retains browser construction options. This is a shell-policy unit test, not observed Chrome offline installation. Actual PWA/extension installation, current-provider OAuth and new-player authenticated playback remain unqualified; npm/crate release is withheld.
