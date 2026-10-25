# Public R2 catalog and datasets

`publishBunVideoExports(catalog, options)` generates a portable SQLite catalog and
JSON, JSONL, SQL and Markdown exports from the dataset column allowlist. It uses
the Bun Cloudflare owner's `createR2Client` and native `Bun.S3Client`.

The default destination is `aphrody-dist`, prefix `bun-video`, served only through
`https://dist.aphrody.app`. Set `bucket`, `prefix` and `publicBase` explicitly for a
different owner-configured custom domain. Credentials remain in the environment
or `~/.aphrody/config/cloudflare.env`; the returned receipt never contains them.

The private catalog is never uploaded. Cookie/environment databases, raw HARs,
body references, local paths, provider sessions, job configuration and errors are
excluded. Article text is opt-in (`includeText: true`) and uses the dataset
redaction/exclusion rules. Arbitrary local asset paths cannot enter this API.

Each object is read back from R2 and its public custom-domain URL and checked by
SHA-256. `manifest.json` is written last, and verified publicly. A failure throws;
it never claims publication merely because upload succeeded. Writes replace the
stable keys; no bucket-wide deletion, backup publication or credential migration
is performed. Other processes consume `bun-video/manifest.json` and its listed
objects and hashes.
