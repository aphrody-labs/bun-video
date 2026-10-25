# Native JSON secrets

`@aphrody/bun-video/secrets` stores owner-selected JSON through Bun.secrets and
Windows Credential Manager. `saveJsonSecret({ service, name }, value)` creates a
credential; `loadJsonSecret({ service, name })` returns parsed JSON or null when the
root is absent. An optional JsonSecretStore supports deterministic local tests.
No provider errors, JSON values, tokens or cookies are logged or written to plaintext
files. The caller must keep returned JSON and its own original protected files private.

The native Windows implementation in `src/jsc/bindings/SecretsWindows.cpp` places
UTF-8 bytes directly in the CredentialBlob and maps `persist: "local"` to the local
machine persistence option. This module explicitly uses that persistence on every
write instead of Bun's default enterprise persistence. It does not enumerate other
credential namespaces or open/decrypt Chrome profiles.
[Repository API documentation](../../../docs/runtime/secrets.mdx) defines get/set/delete.

The [Windows credential contract](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)
limits generic blobs to 2560 bytes. Direct JSON is limited to
2400 UTF-8 bytes. Larger JSON is split into 1797-byte payloads, each stored as a JSON
string containing canonical base64; its credential remains below 2400 bytes. The
manifest contains a UUID generation, total byte length, part count and SHA-256 checksum.
It is committed to the root only after every part is written. Part names derive
exclusively from the supplied service/name, validated UUID and numeric index; the
manifest cannot select arbitrary credential names or services. The stored JSON is
bounded to 1 MiB, and reads validate the exact part count, base64 lengths, byte count,
checksum and UTF-8 before parsing. The checksum detects corruption; vault ownership
and OS access controls provide confidentiality, rather than the checksum.

Service and root names must be nonempty, at most 128 characters and contain no control
characters, whitespace or backslashes. Root names also exclude slash; namespaced
services such as `@aphrody/bun-video` are supported. The `$bunVideoSecret` top-level
object key is reserved for storage manifests. The returned save metadata contains
only format, byte count and chunk count, with no cookie values, checksum or token data.

Writes refuse an existing root. A per-process reference lock prevents concurrent
writes by this module; Bun.secrets has no cross-process compare-and-swap, so callers
must coordinate creation across processes. On failure, cleanup visits only new
attempted keys whose current value still equals the value written by this operation.
Existing credentials and foreign replacements are preserved. A provider cleanup
failure reports incomplete rollback without echoing the provider error or credentials.
Crashes before root commit can leave orphan generation parts; automatic enumeration
or broad deletion is intentionally outside this module's scope. Successful creation
does not delete or migrate the caller's original protected files.

The memory-provider tests cover large Unicode payloads, local persistence, bounded
chunks, missing/tampered parts, malformed manifests, provider-error redaction,
overwrite refusal, concurrent creation and rollback ownership. Live native vault
write/read qualification must use an explicitly selected owner namespace and confirm
only metadata. This module alone does not prove Chrome playback or provider login.

## Crunchyroll lab

The owner-authorized Windows migration uses service `@aphrody/bun-video` and name
`crunchyroll.cookies`. From `C:/bun`:

```powershell
bun bd -j2 run ./scripts/aphrody/hls-keychain.ts --migrate --source C:/Users/aphro/.aphrody/cookies/bun-video/cookie.json --configure-lab
bun bd -j2 run ./scripts/aphrody/hls-keychain.ts --check
bun bd -j2 run ./scripts/aphrody/hls-lab.ts --probe
```

The migration accepts the existing Bun/Chromium bundle and Crunchyroll domains only.
It rereads and compares the credential after creation. An identical existing entry
can be reused; a different entry is preserved and migration fails. The ignored
checkout `cookie.json` remains a symlink, now targeting the protected
`cookie-reference.json` descriptor with provider/service/name only. The original
protected cookie file remains available for owner-controlled rollback.

The lab resolves that descriptor through Bun.secrets and does not fall back to the
original plaintext bundle when its credential is missing or invalid. On 2026-10-11,
native Windows storage and retrieval verified all 17 supplied cookies. The resulting
authorized page GET returned HTTP 200 HTML without a media manifest; that establishes
native credential use and transport, not authenticated migrated playback.

OAuth configuration can be supplied separately with `loadJsonSecret` using a
registered owner-selected service/name. No OAuth client ID or provider registration
is inferred from cookies. Chrome keeps its own authenticated profile; this migration
does not read Login Data, decrypt app-bound browser storage, restart Chrome or bypass
the host's URL verification stop.
