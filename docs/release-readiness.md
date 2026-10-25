# Release readiness — 2026-10-25

## Current serving state

`https://video.aphrody.com/` now serves the Bun Video timeline directly through
the `bun-video-showcase` Cloudflare Worker. The Worker route is
`video.aphrody.com/*` (route `92284de5770447b39ce0f7edac79fc94`). The old
301 redirect to the Bun site is disabled (rule
`c21dc96ff02d40029828fd125456a69b`, ruleset version 5).

The published R2 prefix `showcase/20261022-v3` contains 38 objects, including
the application shell, manifest, 16 MP4 videos, posters, fonts and source
receipts. Live checks returned HTTP 200 for `/`, `/showcase.json` and `/app.js`,
and HTTP 206 for an MP4 byte range. Browser checks confirmed autoplay, vertical
scroll to the next video, seeking and fullscreen.

The public manifest contains 16 videos across Remotion, HyperFrames and
FilmCraft, with 24 evidence records. It does not include the supplied Shenron
episode. Private media, cookies and signed URLs remain outside the public
prefix.

The static timeline is served; the server API is not yet connected. The Worker
has no `BUN_VIDEO_BACKEND_URL`, and `GET /api/health` returns HTTP 503 with
`bun_video_backend_unavailable`. Source edits in this checkpoint make all
showcase paths resolve to the video timeline and remove the catalogue link;
they still need qualification and publication before appearing on the live
site.

## Package state

The source package is `1.4.4-video.5`. A registry read on 2026-10-25 showed
`next: 1.4.4-video.5`, while `latest` remains `1.4.4-video.0`. This is a
prerelease publication, not a stable release.

The VPS and DBFR identities were revalidated through Infra as `vps-203bea89`
and `vps-6732365f`. All three VPS factory slots were free; `/home` had 173 GiB
available. DBFR had 5.1 GiB free on `/`, so no build or media workload should
run there.

The checks above qualify public static serving and browser playback only. They
do not qualify the Bun API backend, editing jobs, server-side source capture,
YouTube API, native decoding/encoding, DRM, GPU rendering, stable npm release,
or the unshipped source edits.

---

Historical audit and remaining qualification notes follow.

The requested delivery is a stable unified Bun Video package on npm and a working
deployment at `https://video.aphrody.com`, qualified using the Shenron catalogue.
This audit is not a release receipt. No new media, package or deployment test has
passed during this audit.

## Observed state

| Surface | Observation |
| --- | --- |
| Source | `packages/bun-video/package.json`: `1.4.4-video.3`; this version is not published |
| npm registry | `latest`: `1.4.4-video.0`; `next`: `1.4.4-video.1` |
| Requested site | HTTPS GET returned HTTP 404 |
| Supplied fixture | `C:\src\shenron\data\episode\Dragon+Ball+Super+Beerus+-+02+VOSTFR.mp4`, 284,260,952 bytes |
| Local runtime | Aphrody doctor recognizes `1.4.6-canary.1`, revision `169d8c5ea` |
| VPS reachability | Native Infra SSH execution succeeded: `vps-203bea89`; DBFR identity is `vps-6732365f` |
| Infra source | `CLOUD-READY.md` was read from `/home/ubuntu/src/aphrody`; the local Aphrody checkout is absent. On VPS, pass `--root /home/ubuntu/src/aphrody` to read its catalogue and scope `APHRODY_INFRA_ROOT=/home/ubuntu` to SSH execution receipts |
| Source checkpoint | Commit `787b89d55b7` is pushed to `main`; the VPS checkout is clean at `38e7beb4be3` and has not been synchronized |
| Shared build lane | A Shenron release currently owns the VPS factory and Cargo locks. Its owner asked Bun Video to wait for an explicit release signal |
| Current code gates | Bun LSP diagnostics pass for the changed source and authored tests; no tests or builds were run |

The native Windows Infra executable is available, but its default local root has
no host catalogue. The canonical CLI and catalogue were therefore used from the
VPS checkout, with explicit source root and receipt root. Read-only Infra status
and SSH identity commands verified both hosts. No source sync, build or service
change has been made from this task; the Shenron build currently owns the shared
VPS lane.

## Qualification and ownership gaps

The repository owner requires builds and qualification on the VPS only.
`scripts/run-package-qualification.ts` already accepts Linux x64/arm64 when an
absolute build-filesystem `TMPDIR` is provided. Its phases include source/script
type checks, lint, formatting, library build, and outside-consumer archive
qualification. These gates remain unrun for the current source checkpoint; they
can start only after the active Shenron build releases the shared factory lane.

`scripts/publish.ts` requires the exact archive's successful outside-consumer
receipt, registry-sourced types, export checks and the current runtime revision.
Keep those checks when consolidating the qualification runner.

The existing data-site server is documented as a loopback workshop. Its Host
and Origin checks and private catalogue handling need explicit review before
using it as the public service. A local server starting does not qualify the
requested public domain.

## Remaining delivery gates

1. **Complete:** read `CLOUD-READY.md` and verify both host identities through
   the native Infra catalogue. Before any future host mutation, prepare and
   verify its Infra plan; keep the source checkout rooted at
   `/home/ubuntu/src/aphrody` and receipt root scoped to `/home/ubuntu`.
2. Use catalogue episode **876**, series `DBS_BEERUS`, number **2**, for the
   supplied fixture. The current
   [episode catalogue](https://dragonballfr.com/api/episodes?series=DBS_BEERUS&limit=20)
   lists its public CDN source under SHA-256
   `d4d484227c84427b0a1dcfd7e1070ae4c0f4f33f5f3c53073be6bfbe7df24e70`;
   the supplied local file has that exact SHA-256. Its `nativeSource` is null,
   so its canonical native transport is unavailable in this response. This
   metadata and file-integrity observation does not qualify decoding or playback.
3. Consolidate the existing library build and consumer qualification for the
   VPS's target. Reuse one shared factory lane and existing outputs.
4. Qualify source checks, protocols, native decoding and transformations,
   remux/frame/audio readback, worker cancellation and the outside-package
   consumer. Qualify renderers, encoding and GPU paths separately.
5. Exercise the supplied episode and a bounded catalogue sample without
   modifying source media. Keep media, cookies and signed URLs out of Git,
   npm and the public deployment.
6. Publish only the exact qualified archive; read back registry version and
   integrity. A prerelease `next` publication alone is not a stable release.
7. Deploy through the Infra owner, then verify public HTTP, browser playback,
   seeking, subtitles, jobs and error paths. Record the deployed revision and
   actual results, and synchronize PC/VPS at the delivery boundary.

Earlier results and their limits remain in [Qualification](qualification.md).

## Catalogue qualification preparation

`scripts/aphrody/shenron-video-corpus.ts` now accepts `--episode-series` with
`--episodes`. The series is included in both metadata requests and checked
against each returned episode. The report retains the selected series and
the IDs of episodes missing a canonical native source. Stored provider players
are still excluded rather than substituted for a missing native transport.

Two new hermetic cases cover the `DBS_BEERUS` page, omitted sources, response
series mismatches and invalid series before network requests. They have not
run: the workstation does not run qualification hooks, and VPS access remains
blocked. The pending focused VPS gate is:

```sh
bun factory run -- bun bd test scripts/aphrody/shenron-video-corpus.test.ts
```

Native type, lint and formatting gates for the changed scripts also remain
pending on the VPS. This source checkpoint is not qualification or publication.
