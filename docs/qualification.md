# Qualification

## Native ingestion, 2026-10-18

On Windows x64, Bun `1.4.6-canary.1` at revision `169d8c5ea` runs the package
TypeScript directly. The seven focused source, pipeline, root-import, FFmpeg contract, API
registry, worker-task and pixel-verification suites pass 26 tests with 172
assertions; five optional media/GPU SDK cases are skipped.

The cold-process pipeline test first verifies that its module hook rejects the
FFmpeg adapter. With optional FFmpeg/mpv/SDK imports still rejected, it ingests
a local HTTP MP4 fixture through `createVideo` and checks native frame count,
width and file size. This is a container/timing fixture, not a decoder vector.
It also proves that an advertised input above 256 MiB is cancelled before
reading. Source tests separately exercise actual streamed byte limits, false
Content-Length, binary views, HTTP errors and cancellation during a pending read.

The root-import process independently rejects framework, React and optional
media SDK imports while reading the same native metadata. It then explicitly
loads Remotion, checks interpolation output and verifies that the root loader
and typed API registry return the same implementation. Root rendering helpers
and optional services now use their explicit module subpaths.

Native lint and formatting pass for the four changed source/test files. Native
type checking with `tsconfig.check.json` and those four entrypoints passes its
22-file dependency closure. The full project still reports 46 diagnostics in
absorbed Remotion/HyperFrames sources. These scoped results do not qualify full
rendering, video encoding, the optional SDKs or the package release artifact.

## 2026-10-10

Scoped TypeScript, Oxfmt 0.72.0 and Oxlint passed. The changed Bun binary ran
100 tests across six files with 253 assertions and zero failures. This covers
actual Remotion interpolation, ordered worker backpressure, cancellation,
protocol validation and framework adapters; adapter tests do not qualify a
native browser device.

The standalone Windows Rust crate passed formatting, check, ten tests including
exact FFV1 RGBA roundtrip and abrupt-parent process ownership, and strict Clippy.
Its executable probed actual RTX 4070 NVENC successfully using verified FFmpeg
9.0.2. NVENC is an explicit lossy mode and does not preserve alpha. GPU encoding
does not prove GPU frame rendering.

HyperFrames' individual compiled executable rendered a three-frame H264 MP4 in
a clean directory with embedded codec and Sharp assets and an external installed
Chrome browser. Remotion's compiled library exposed actual core and renderer
exports outside the checkout. Its complete standalone composition rendering
remains a separate gate. See each framework's qualification JSON for artifact
hashes and the precise scope of earlier builds.

The browser-enabled Aphrody DLL factory exhausted the local disk and did not
produce a release provider. Existing installed providers lack the required
browser/Oxc capabilities. Native M3/Obscura full-render benchmarks consequently
remain blocked. The seven-sample function benchmarks establish equal output,
not an end-to-end video speed improvement.

Original upstream whitespace is retained in vendored source. New integration
files passed the scoped staged whitespace check. Git LFS media remains represented
by pinned upstream pointers and requires hydration before media-dependent use.
Dependency closures retain separate exact locks pending full rendering gates.

Automatic review rejected removing two obsolete temporary executables with
`blocked by policy`. Neither deletion nor a substitute deletion was performed.
Native NTFS compression instead preserved both artifact paths and verified
unchanged SHA-256 content, reducing allocated storage by approximately 747 MB.

## Delivery boundary

The source batch was committed locally as
`6e32b368b4ef2821579bf6e0f3784ead5b1707bb`. A disjoint merge delivery commit was
prepared without changing the shared dirty worktree. Primary GitHub metadata
then confirmed that the only owner origin, `aphrody-labs/bun`, is a public fork.
GitHub rejected new LFS objects with `can not upload new objects to public fork`;
the upload remained at zero objects and remote main stayed unchanged. No LFS
hook, permission or visibility setting was bypassed. On 2026-10-10 the owner
explicitly authorized public development and publication and removed the legacy
private-only rule. Delivery still needs a remote that accepts these LFS objects;
the public fork restriction is a technical blocker, not an authorization blocker.
