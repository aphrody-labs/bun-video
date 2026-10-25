# Shared documentation

`catalog.json` indexes both retained documentation trees and authoring skills by
source path and SHA256. `bun scripts/catalog.ts` regenerates it. Equal hashes
identify duplicate content without deleting upstream provenance or license text.
The common entry point is `../README.md`; native media details are
`../native/README.md`, benchmark methodology `../video-benchmark/README.md`, and
agent authoring `../../../.claude/skills/bun-video/SKILL.md`.

The unified executable preserves every upstream command. React compositions use
Remotion's render lifecycle; HTML timelines use HyperFrames' seek lifecycle.
Native workers share ordering, time bounds and encoder backpressure. Unsupported
native media is rejected until frame/audio parity is qualified.
