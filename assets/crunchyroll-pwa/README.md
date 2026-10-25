# Bun Crunchyroll shortcut PWA

Serve this folder at the same-origin `/pwa/` route using the supplied Bun server. Open its localhost address in Chrome. The manifest defines a standalone shortcut with real local PNG icons at 192 and 512 pixels; the install button activates only if Chrome sends `beforeinstallprompt`. Chrome’s own install menu is another option. Installation has not been claimed or performed automatically.

The local shell supports English, French, Spanish, Portuguese, German, Italian, Arabic (RTL), Japanese, Korean, Hindi and Russian with locale fallback to English. A local preference changes only the shortcut’s UI. The watch button opens the user-supplied official French episode in a separate tab; Crunchyroll manages authentication, entitlement, audio, subtitles and DRM.

The service worker is scoped to `/pwa/` and caches an exact allowlist of its own same-origin static shell GET assets only. It never caches Crunchyroll requests, media, cookies, account routes or external resources. Version updates remove only caches with this shortcut’s own prefix. The offline shell can display the shortcut; streaming still requires internet and authorized site access. Keep the Bun server on a stable localhost origin for repeat visits and installation; changing its port changes the application origin.

The CR monogram PNGs were generated locally with Windows drawing APIs. They are original shortcut artwork and are not official Crunchyroll brand assets. This is a companion shortcut; it does not redistribute the episode or bypass any subscription or license checks.
