# Architecture: Aphrody Video

## Stack

- Web app: static React/TypeScript bundle compiled by native Bun and served from the existing Cloudflare Worker; reuse the current deployment and R2 object store.
- Styling: the repository's Material 3 token package, with Bun orange as the dynamic seed and responsive CSS owned by Bun Video.
- Media catalog: versioned, generated `showcase.json` in R2. Public entries reference only published posters, videos and source evidence.
- Playback: browser-native `<video>` for the qualified MP4 showcase; HLS/DASH and specialty providers are added through existing adapters only after browser/provider qualification.
- Server/media pipeline: existing Bun Video package APIs and worker pool; Cloudflare Worker remains a read-only static CDN at first.
- Persistence: browser local storage for saved IDs/playlists in the MVP. No cloud user data or server mutations until auth and access rules are designed.
- Hosting: Cloudflare Worker route `video.aphrody.com/*` with the `aphrody-video` R2 bucket. Deployment and asset publication are distinct operations and each needs an integrity/HTTP check.

## Data model

MVP is read-only and derives video records from the generated manifest; do not duplicate them in a second database.

- `Work`: `{id,title,description,engine,features,durationFrames,fps,width,height,poster,video,captions,chapter,sourceRef,evidence}`.
- `SavedCollection`: `{id,name,workIds,updatedAt}` stored locally, with stable IDs and unknown IDs dropped on catalog refresh.
- `PlaybackState`: `{workId,positionSeconds,muted,updatedAt}` stored locally only when the user opts to resume.

If server accounts are added later, use Postgres with `users`, `collections`, `collection_items`, and `playback_progress`, ownership foreign keys, cascading deletion and an authorization check on every write. No migration is part of this static MVP.

## Routes and API

| Method / route          | Caller     | Input                     | Output                          | Flow    |
| ----------------------- | ---------- | ------------------------- | ------------------------------- | ------- |
| `GET /`                 | public     | none                      | discovery app shell             | S01     |
| `GET /watch?v=<workId>` | public     | catalog work ID           | watch view using the same shell | S02     |
| `GET /shorts`           | public     | optional `?v=<workId>`    | full-screen timeline            | S03     |
| `GET /playlist/<id>`    | local user | local collection ID       | saved collection view           | S04     |
| `GET /studio`           | public     | none                      | capabilities and workflow entry | S05     |
| `GET /showcase.json`    | public     | conditional/range request | generated catalog JSON          | all     |
| `GET /<catalog asset>`  | public     | conditional/range request | typed R2 object                 | S01-S03 |

The Worker allows only GET/HEAD and denies path traversal. No original YouTube endpoints, cookies, user accounts, uploads or third-party downloads are proxied by the site shell.

## Pipeline integration

1. Resolve a source using the existing `source`, `catalog`, `hls`, `dash`, `har`, `ytdlp` and authorized provider modules.
2. Probe format/protocol/codec and choose a qualified reader (`Bun.Video`, MediaBunny, browser-native, or optional licensed provider).
3. Use the canonical pipeline for bounded inspection, transforms, cuts and remux; keep FilmCraft/Bun.Video native providers and Bun.Image for native media operations.
4. Compose deterministic overlays with Remotion or HyperFrames and compare evidence when parity is expected.
5. Encode with a qualified provider, package captions/manifests, and publish only through an explicit planned destination.

No format or codec is advertised as universally supported. Runtime decoder, browser codec, native provider, renderer, encoder and GPU support are separately qualified.

## Risks and boundaries

- Autoplay is browser policy; the UI must provide a visible play control and stop media when offscreen.
- Range behavior is required for efficient video seeking and needs live tests on deployed R2 objects.
- Public MP4 showcase files are generated first-party assets. Shenron source media, cookies, HARs and signed URLs remain private.
- Local playlist data can be cleared by browser storage settings. Cloud persistence requires accounts and access control.
- Source downloads and uploads require size limits, rights/authorization, SSRF protections, rate limits and private job workspaces before they can be exposed publicly.
- `video.aphrody.com` route and Cloudflare binding are production infrastructure; the runbook requires catalog-backed plan before apply and live readback after deploy.

## Build order

1. Complete the discovery/watch/Shorts loop on the existing generated catalog and deploy it.
2. Add local saved collections, search refinements and keyboard/accessibility behavior.
3. Expose capability-based pipeline jobs with bounded input sources and progress; qualify each source and codec independently.
4. Add creator accounts and cloud collections only after a server-side auth/data contract exists.
