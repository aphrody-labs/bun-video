# Recon: video.aphrody.com as a clean-room video platform

Scope: responsive web application for Bun Video and Aphrody users. Rebuild familiar video discovery and playback flows from public YouTube UX patterns, then connect them to Bun's own media capabilities. Use original Aphrody/Bun branding, original generated media and first-party integrations; do not copy YouTube assets or private endpoints.

## Sources

| Source                 | URL                                                                               | Evidence used                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Public home            | https://www.youtube.com/                                                          | Video-first discovery, search, channel-oriented navigation                                       |
| Upload help            | https://support.google.com/youtube/answer/57407?co=GENIE.Platform%3DDesktop&hl=en | Upload and publish flow, visibility choices                                                      |
| Playlist help          | https://support.google.com/youtube/answer/57792?hl=en-GB                          | Save and organize videos into playlists                                                          |
| YouTube Help topics    | https://support.google.com/youtube/answer/16517743                                | Shorts, live, comments, captions, creator analytics and channel controls                         |
| Local Bun Video API    | `packages/bun-video/docs/` and `packages/bun-video/src/`                          | Source, format, player, composition, render and native media capabilities                        |
| Public showcase corpus | `https://video.aphrody.com/showcase.json`                                         | 16 generated works and their engine, duration, poster, playback asset and qualification evidence |

## Screen inventory

| ID  | Screen      | Route            | Purpose                                                   | Main components                                                             | States                                                 |
| --- | ----------- | ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| S01 | Discover    | `/`              | Search and browse the generated video catalog             | Top bar, search, side navigation, category chips, responsive video cards    | loading, loaded, empty, failed, filtered               |
| S02 | Watch       | `/watch?v=<id>`  | Watch a video and discover related work                   | Native video player, metadata, source/evidence, save/share, related videos  | loading, playing, paused, seek, fullscreen, error      |
| S03 | Shorts feed | `/shorts`        | Full-screen snap-scrolling sequential video feed          | Viewport player, active-video controls, progress, next/previous navigation  | autoplay blocked, playing, paused, reduced-motion, end |
| S04 | Collection  | `/playlist/<id>` | Organize and revisit a local saved-video collection       | Collection header, ordered video list, remove/reorder                       | empty, populated                                       |
| S05 | Pipeline    | `/studio`        | Explain and route work through unified media capabilities | Source intake, format/player capabilities, compose, transform, export steps | capabilities unavailable, ready, job pending/failed    |
| S06 | About       | `/about`         | Explain runtime provenance and qualification boundaries   | Bun native media, FilmCraft, Remotion, HyperFrames evidence                 | data present, data unavailable                         |

## Core flows

1. Discover: load the versioned manifest, filter by engine/capability, search title and description, select a card, and open S02.
2. Watch: play/seek/fullscreen with the browser's native media element, save locally, and navigate to related work.
3. Shorts: enter S03 from a card and scroll or use arrow keys to load the next/previous video. Keep reduced motion and autoplay policy intact.
4. Pipeline: choose an authorized local or public source, identify supported format/protocol, then hand off to existing Bun Video APIs. Never expose credentials, cookies, raw captures or signed source URLs.

## Feature matrix

| Area                       | Core behavior                                                                                                                    | Phase                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Discovery and search       | Search, engine/capability filters, responsive generated-media catalog                                                            | MVP                                                                         |
| Playback                   | Native HTML media, seeking, captions when present, fullscreen, related works                                                     | MVP                                                                         |
| Shorts                     | Full-screen snap timeline with one adjacent video prefetched                                                                     | MVP                                                                         |
| Saved collection           | Browser-local saved IDs and playlist ordering                                                                                    | MVP                                                                         |
| Unified media pipeline     | Source normalization, HLS/DASH, browser player integrations, native decode/transform/remux, Remotion and HyperFrames composition | Integrate through existing APIs; qualify each provider separately           |
| Creator studio             | Upload/local file intake, source URL jobs, edit/cut, encode/export, job progress                                                 | Next; server job API and auth/limits must be defined before exposing writes |
| Accounts and collaboration | Auth, cloud libraries, comments and sharing                                                                                      | Later; no account or database contract assumed                              |

## Clean-room boundaries

This is an independent product. Use no YouTube logos, copied page assets, private APIs, account scraping, or third-party video content without rights. The public interface may inform interaction patterns; all brand assets and showcase works are Bun/Aphrody-owned. The Shenron fixture stays private and is not published.
