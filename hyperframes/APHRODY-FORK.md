# Hyperframes on the Aphrody Bun runtime

`UPSTREAM.json` pins the complete upstream source import. Every one of the
9,092 upstream tracked paths is retained. Git LFS media stays as its original
pointer blob; hydrate it in a separate upstream/render workspace before running
media-dependent fixtures. `LICENSE` and all upstream notices are retained.

All 22 named package manifests, including nested composition fixtures, declare
Bun >= 1.4.3. Node and tsx script runners use Bun, and shell/workflow execution
commands use Bun. Node compatibility imports remain when they preserve behavior.
Upstream package dependency versions, export contracts, browser toolchains and
cloud-provider runtime declarations remain authoritative.

## Migration evidence

`bun n2b C:/bun/vendor/hyperframes --aggressive --dry-run --agent --report json`
was followed by the aggressive apply. `aphrody/n2b-plan.json` and
`aphrody/n2b-applied.json` preserve per-file rule counts. Detailed reports live
only in the owner's ignored `tmp/hyperframes-migration/` workspace. The tool's
`files_scanned` counts report entries with findings or changes, not all files.
`aphrody/reviewed-edits.json` records the review of 1,800 reported changed files.
Synchronous-to-asynchronous I/O, Buffer-to-Uint8Array, compiler, dependency and
CI installer transformations were restored where the mechanical rewrite did
not establish equivalent behavior. The applied shebang, import-prefix, ESM path
and package-runner changes are retained. `aphrody/workspaces.json` inventories
every named package; `aphrody/runner-files.json` records shell/workflow changes.

For a fresh import, use an external pinned upstream checkout as
`HYPERFRAMES_UPSTREAM_ROOT` and a detailed aggressive report as
`HYPERFRAMES_N2B_REPORT` when running `aphrody/review-migration.ts`, then run
`aphrody/finalize-migration.ts`. These scripts perform migration; they do not
claim build or runtime qualification. The owner checkout runs the final gates.

## Native WebView frame capture

`@hyperframes/engine/native-webview-capture` exports
`captureNativeWebViewFrames(context, options)`. Pass a context from the Aphrody
`BrowserRuntime` SDK with the viewport, allowed origin and private-network
policy configured by its owner. The context must provide `navigate`,
`evaluate` and PNG `screenshot`. The caller owns closing it.

This capture path waits for the Hyperframes seek protocol and fonts, seeks
exact rational frame times, awaits the page's seek-completion and synchronous
flush hooks, and yields PNG frames. It rejects video/audio injection, shader
transitions and declared WebGPU requirements because this adapter cannot fulfill
those contracts. It does not encode, mix audio, emulate CDP or silently launch
Chromium. The existing Puppeteer producer remains available for those features.
Native backend availability and screenshot paint fidelity need a real host
fixture; unit coverage alone does not prove a replacement renderer.

Upstream formatting, lint, typecheck and package tests remain required.
Rendering tests additionally require hydrated LFS fixtures, package builds and
the chosen browser/FFmpeg backend. Publishing commands and credentials are not
executed by this import.

## Standalone CLI build

`bun aphrody/standalone-build.ts <absolute-output-path>` prepares the four core
runtime modules and compiles the entire upstream CLI command graph. The helper
exports its prep, configuration and build functions for the combined bun-video
dispatcher. Compiled render provenance uses the pinned engine version.

`aphrody/sharp-native-plugin.ts` embeds the installed Windows x64 Sharp addon
and libvips DLLs, materializes them into an isolated native loader directory and
loads the addon from that directory. A compiled clean-directory fixture produced
a real PNG through Sharp without a local node_modules directory. Other native
targets require separate qualification.

`aphrody/standalone-qualification.json` records executable and clean-directory
checks. CLI dispatch and HTML lint work without a local node_modules directory.
The individual executable also embeds the shared Remotion compositor codecs,
the verified Hyperframes runtime manifest/IIFE and the render setup worker.
A clean-directory render with no codec overrides produced an H.264 MP4 with
three 320×180 frames. The existing producer used the host's HeadlessChrome 152
backend; a qualified browser and command-specific static assets remain required.
This proof does not establish native WebView production parity.
