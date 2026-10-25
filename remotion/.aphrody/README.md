# Aphrody Remotion source fork

The immutable upstream revision, license and source inventory are in
[UPSTREAM.json](../UPSTREAM.json). Every tracked upstream source path is retained.
Media fixtures, screenshots, fonts and compiled compositor binaries are omitted;
the exact path and byte inventories are in [excluded-files.json](excluded-files.json).
Recover those files from the pinned upstream revision before a complete render,
browser test or documentation build. Upstream license conditions in
[LICENSE.md](../LICENSE.md) remain applicable; vendoring grants no publication rights.

`bun n2b --aggressive --dry-run --agent` was followed by
`bun n2b --aggressive --agent`, scoped to this folder, with `.aphrody/**` ignored.
[n2b-plan.json](n2b-plan.json) and [n2b-apply.json](n2b-apply.json) contain compact
machine-readable reports. The CLI's `files_scanned` counts files with findings,
not the total traversal population. [n2b-review.json](n2b-review.json) records
526 retained import-prefix and Bun-shebang edits and 642 rejected suggestions.
Synchronous filesystem functions retain their return contracts, directory checks
and Buffer behavior. Custom dotenv resolution, browser Vitest, subprocess
streaming and cancellation retain upstream semantics. Mechanical async rewrites
also included malformed nested arguments; those edits are reverted explicitly.

Upstream already uses Bun workspaces, a Bun lock and Bun tests. The fork keeps
React and React DOM: M3 styling does not replace Remotion's React composition
model. The benchmark at `../../video-benchmark` compares the real upstream
timeline interpolation function against this source on the same installed Bun.
It does not measure React DOM rendering, video encoding or a migrated bundler.

## Native React frame capture

[native-frame.ts](native-frame.ts) exports `captureNativeRemotionFrame` for a
served React composition initialized with Remotion rendering globals before
hydration. It loads the precompiled Obscura browser SDK, negotiates actual native
browser capabilities, seeks with the upstream `remotion_setFrame` contract,
honors render cancellation and `delayRender` readiness, waits for fonts and
returns a native PNG screenshot. It never launches a Chromium executable.
The caller must supply exact permitted origins, viewport and composition id;
private-network access is an explicit option. Native contexts and libraries close
on success, cancellation and failure.

This is a separate frame API. It does not substitute for `openBrowser` or claim
CDP parity. Upstream `HeadlessBrowser`, `BrowserPage`, `make-page.ts` and
`set-props-and-env.ts` additionally require document-start injection, CDP targets,
sessions, network interception, JS handles, console/error events and compositor
media extraction. The current SDK exposes navigation, evaluation and PNG capture
but no document-start injection. A raw Remotion bundle URL therefore needs a
server-controlled bootstrap before using this adapter. Full native React video
rendering requires those integration contracts and real frame/output parity gates.

## Compiled delivery qualification

`standalone-build.ts` resolves the pinned workspace source and embeds the Windows
compositor assets. `module-assets.ts` materializes the real browser modules and
loaders needed by native Webpack/Rspack. Literal `require.resolve` calls are kept
at runtime so compiled paths cannot point back into this checkout. The browser
assets use explicit relative ESM extensions. Seven sources with explicit resource
management require the pinned upstream ESbuild lowering because the installed
Bun transpiler currently emits a `bun:wrap` import for those browser modules.

The last compiled unified executable, its exact hash, cleanroom failures and
compiled MCP stdio proof are recorded in `standalone-verification.json`. The
library was compiled and loaded without cwd `node_modules`; its real Remotion
core and renderer exports were checked. The last executable reaches browser
bundling but fails on `bun:wrap`. The corrective source exists; subsequent PE
builds failed with insufficient disk space, including the attempt using an NTFS
compressed temporary directory. Full Remotion React video rendering is therefore
not qualified by this work.

Materialized modules may remain after process exit on Windows because native
DLLs are still loaded when the exit cleanup runs. Their size is about 561 MB per
process. The exact stale extraction directories were inventoried; automatic
review rejected their deletion. NTFS compression preserved their contents and
native binary hashes. A distribution must address this extraction/cache lifetime
and qualify a complete real bundle and render before claiming standalone parity.
