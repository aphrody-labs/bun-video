# Official Crunchyroll page as a Chrome site app

The Bun launcher opens the authorized official watch URL in a standalone Chrome app window using the existing running browser's user data directory and profile. It preserves the profile and existing authentication; it neither restarts Chrome nor copies profile data.

```powershell
bun run ./src/apps/crunchyroll-app.ts --check
bun run ./src/apps/crunchyroll-app.ts --install --open
```

`--check` reports the proposed executable, arguments and profile metadata without launching or installing. Discovery selects the unique running Chrome browser process, its explicit directory flags where present, then its `Local State` last-used profile. Ambiguous browser processes or multiple active profiles stop automatic selection.

The safe capability probe loads `bun:chromium`, `bun:chrome` and `bun:google`, checks the aliases, validates the official URL with the native protocol helper and exercises installed-executable discovery. `profiles.readBookmarks` is checked for availability without reading bookmark data. These capabilities are separate from live CDP control: an existing Chrome profile needs a debugging endpoint for that. The active-process metadata governs profile selection because the available profile helper reads bookmarks rather than selecting active profiles.

`--install` creates `Crunchyroll - Bun Chrome.lnk` on the current Windows desktop through WScript.Shell. The shortcut targets the installed Bun runtime and this absolute launcher script; subsequent launches rediscover the running Chrome profile. `--open` starts Chrome with `--app` and the existing directory/profile. Chrome handles the running-profile handoff itself.

The launcher lives inside the installed `@aphrody/bun-video` package at `src/apps/crunchyroll-app.ts`. Commands above run from that package directory. In the Bun checkout, `scripts/aphrody/crunchyroll-app.ts` remains a compatibility wrapper and qualification uses `bun bd`.

This is a Chrome site app. A verified installable site manifest, service-worker/offline support and genuine installed PWA are not established by an app window or shortcut. The official site owns playback, browser DRM, subscription authorization and licensing.

Use the separate DASH dashboard for the Bun adapter and offline HAR replay tests; this official-page app verifies opening and preserving the real browser environment. Playback on the official page does not establish that Bun independently decoded the video or acquired DRM licenses. No credentials or capture contents are embedded in the launcher or shortcut.
