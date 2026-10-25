# Authorized live DASH transport

`scripts/aphrody/dash-lab.ts --live-config <absolute protected JSON> --check`
fetches an explicitly authorized MPD through Bun and verifies local URL rewriting.
Remove `--check` to serve the diagnostic dashboard. The default mode still replays
the supplied HAR; live mode is explicit and uses no browser-profile extraction.

Private configuration belongs outside the repository, for example under
`~/.aphrody/cookies/bun-video`. Its schema is:

```json
{
  "src": "https://media.example.test/manifest.mpd",
  "allowedOrigins": ["https://media.example.test", "https://cdn.example.test"],
  "headersByOrigin": {}
}
```

Caller-owned headers can be configured for each exact allowed origin. HTTPS is
required outside loopback tests. Redirects
are refused, browser request credentials are ignored, and signed source/media URLs
are replaced by local UUID routes before reaching the dashboard. Only MPD fetching
and GET/HEAD media transport are supported. POST requests and license endpoints
are refused. No authorization headers, cookies or private configuration are returned
by diagnostic routes or printed. Do not commit configuration, raw captures or media.

This laboratory supports SegmentBase manifests with simple BaseURL resources;
templates, lists and external manifest references are rejected. The underlying
public dash.js adapter retains its normal DASH capabilities. A successful transport
test does not prove decoding, entitlement, French catalog availability or service
API compatibility. DRM remains with the official authorized playback integration;
the existing adapter's caller-owned `protectionData` API is unchanged.

Use deterministic loopback tests for this transport and the native API client.
Live tests are limited to the owner-selected Crunchyroll session and routes. A
currently playing official Chrome video is an account/browser baseline, while
the new Bun player still needs its own playback and cleanup evidence before release.
