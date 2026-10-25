# Standalone source packaging

The npm package keeps TypeScript source and the frame-worker.ts entry point.
No package import may refer to the monorepo's vendor or sibling packages.
Remotion 4.0.534 and HyperFrames 0.8.144 use their official npm distributions;
only the bounded native capture adapters and orchestration are copied locally.
The published HyperFrames engine does not export native-webview-capture.

The files allowlist contains src, docs, assets, README.md, LICENSE,
and THIRD_PARTY_NOTICES.md. Tests, protected session inputs, temporary output,
node_modules and the repository's vendor tree are excluded. Publication must
also inspect the actual packed listing: an allowlisted directory must never
contain a private input. The native runtime and external media tools are not
embedded in this package.

The registry tarball for @aphrody/bun-runtime-sdk 1.4.5 was inspected on
2026-10-11. Its src/video/hls.ts exports attachHlsPlayback and has SHA256
`61ea6a7eade2c0472b959dd010ff9feb4bca6d7f9bb03385ea2394b0a55662f2`,
identical to the session's local SDK lifecycle adapter. This checks the
published API artifact, not browser decoder or protected-content playback.

For a future JS distribution, Bun.build should use target bun, ESM and
external official dependencies. A separate frame-worker entry point and
rewritten worker URL are required; a root-only bundle is insufficient.
The current source distribution preserves the relative worker entry point.

The release is 1.4.4-video.0 on the next tag. Before publishing, pack a
source-pinned staging directory and test an isolated consumer, including all
public subpaths and lazy library loaders. This avoids altering or publishing
concurrent monorepo work. Required native tests use the fork's bun bd gates.

The official Remotion renderer 4.0.534 rejects Bun prerelease versions such as
1.4.4-debug and 1.4.3-aphrody.4 at import: its minimum-version check excludes
prereleases. `loadRemotionRenderer()` preserves that upstream check. The three
other library loaders and package utilities are qualified separately; importing
the renderer or rendering a composition is not claimed for those runtimes.
