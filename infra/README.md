# Host qualification

Use the canonical native owner CLI, not SSH aliases:

```text
aphrody infra ssh exec --host vps --json --cmd '<read-only host plan>'
aphrody infra ssh exec --host dbfr --json --cmd '<read-only host plan>'
```

Read the configured Aphrody repository's `docs/operations/cloud/CLOUD-READY.md`
before applying changes. Resolve paths on the selected host. Build the standalone
Rust crate on the VPS; DBFR receives qualified artifacts and never runs Cargo.
Use native SFTP for bounded source archives and artifacts. Preserve services,
provider stores and unrelated builds. A Windows executable is not a qualified
Linux release. Browser/GPU, FFmpeg and native SDK capabilities must be probed
on each target before running its render workload.

## Evidence as of 2026-10-10

The isolated VPS directory `/home/ubuntu/builds/bun-video-native-20261010`
contains the final native sources. Native SFTP uploaded a 13,273-byte archive
containing only Cargo.toml, Cargo.lock, clippy.toml, README.md and src/.
Its SHA-256 is
`785e8dbee192a0950422d2fdd12849d436121f2eb88f81592cec668c88da7e4e`.
The archive contents and destination were inspected before extraction; no
unrelated sources, services or caches were changed manually.

Six tests, including exact FFV1 RGBA roundtrip, passed on an **earlier** source
version with `/usr/bin/ffmpeg` 8.0.1. Those results do not qualify the final
process-ownership implementation. Final Linux check, tests including ignored
tests, all-targets strict Clippy and release build have **not executed**.

The final run used tmux session `bun-video-native-final-20261010` and the
canonical `scripts/build/rust/cargo-serial.sh`, with APHRODY_BUILD_HOST=vps,
two jobs and sccache preserved. Its direct factory route acquired heavy.lock
in flock PID 34707, a child of resource-owner PID 34688. The command body
re-entered the resource owner as PID 37307: `inheritedFactoryResourceHeld`
checks whether the FLOCK owner is an ancestor, but the original lease was a
sibling. It therefore attempted another acquisition in flock PID 37338 and
blocked before Cargo. No global lock was bypassed or factory code modified.
Only this run's PIDs 37338, 37307, 34707, 34688, 34687 and 34685 were stopped;
their exit was verified and other factory jobs remained intact.

The owner also exposes `build-factory plan/run --repo ... --revision <full-sha>`
and `vps-cargo run --repo ...`, which acquire the global lock in the parent
command chain. These routes require declared repository configuration and
pinned or synchronized source; they are not an arbitrary-archive flag for
the isolated bun-video directory. No factory configuration was added to
pretend that this directory was a declared repository.
Read-only inspection of the canonical `/home/ubuntu/src/aphrody` checkout
returned revision `e9ae35a055c44b260cdb890d592b6c026d014819` with a modified
Cargo.lock. The pinned factory route requires a clean checkout, so that route
was not launched and the concurrent lockfile change was preserved.
The official repository lists were checked in both the local owner config
and the VPS copy: build-factory declares aphrody, yolo and iecode;
`tools/config/host/vps-cargo.json` declares vu, shenron, shenron-release and
shenron-omar (plus its default Aphrody checkout). Neither registers bun or
bun-video. A private Bun commit/push therefore does not by itself enable a
configured pinned factory build for this crate. No new host or repository
registration was fabricated.

DBFR was inspected read-only through its owner transport: x86_64,
FFmpeg `8.0.1-3ubuntu2`, approximately 31 GiB free. The planned isolated
destination `/home/ubuntu/releases/bun-video-native-20261010-final` did not
exist. Delivery is blocked pending final Linux gates: no binary was uploaded,
no service activated and no Cargo command ran on DBFR. Once qualified, transfer
only the release binary through native SFTP, compare SHA-256, then probe the
installed FFmpeg from that isolated directory. Media tests alone do not qualify
native browser rendering or GPU hardware on either host.
