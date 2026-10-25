# Qualification remaining

## Native unification audit, 2026-10-18

- [x] Native `createVideo` ingestion through the dedicated `/pipeline` export
      without importing FFmpeg, mpv or external runtime SDK adapters. Cold-process
      isolation and local HTTP metadata checks pass.
- [x] Bounded binary/HTTP ingestion, failed-response cancellation and pending-read
      cancellation, including the native 256 MiB streamed-input limit.
- [ ] Remove mandatory external executable encoding: `src/encode.ts` still
      requires `nativeExecutable` and calls `Bun.spawn`; `Bun.Video` has no public
      video-frame encoding terminal. Preserve real encoding coverage when replacing it.
- [x] Make the root entrypoint independent of framework implementations:
      cold import rejects framework, React and media SDK imports. Optional APIs
      remain accessible through their existing subpaths and the typed registry.
- [ ] Complete source ownership consolidation: Remotion, HyperFrames, Mediabunny
      and yt-dlp source trees remain in the package. Absorbing those directories does
      not prove the requested independence or removal of vendored implementations.
- [ ] Close full-project types: the native check currently reports 46 diagnostics
      in 23 absorbed framework files. The changed ingestion closure passes separately.
- [ ] Qualify decoding, audio, encoding, rendering, GPU paths and distributed
      artifacts separately on each claimed target. This batch qualifies Windows x64
      source ingestion and container metadata only; see [qualification.md](qualification.md).

## Earlier qualification record, 2026-10-10

- [x] Scoped TypeScript, Oxfmt, Oxlint and changed-binary Bun tests: 100 tests across six files, 253 assertions.
- [x] Windows native Cargo check, ten tests, strict Clippy and exact FFV1 roundtrip.
- [ ] Complete unified executable clean-room rendering for both frameworks.
- [ ] Qualify browser-enabled Obscura, native Oxc and M3 providers on a GPU host.
- [ ] Compare equal rendered frames, audio and encode workloads on qualified hosts.
- [ ] Register shared tools in the canonical host after capability qualification.
- [ ] Consolidate dependency locks after both full build closures are qualified.
- [ ] Deliver publicly through an owner-authorized remote with working Git LFS.

Windows standalone compilation and browser-provider linking are blocked by local
disk exhaustion. Automatic review rejected removal of two obsolete owned PE
artifacts with `blocked by policy`; no deletion or bypass was performed.
The existing origin is a public GitHub fork and rejects new LFS object uploads.
The integration is committed locally; its attempted push was rejected before
the remote main changed. No LFS checks or repository visibility were bypassed.
The owner authorized public development and publication on 2026-10-10; a private
destination is no longer required. The GitHub fork LFS restriction remains technical.
