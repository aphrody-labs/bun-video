# Captured HAR inspection and local media replay

`@aphrody/bun-video/har` reads a local HAR through Bun, selects captured HLS or DASH manifests, and replays available media response bytes. It never fetches missing resources.

```ts
import { loadHarCapture } from "@aphrody/bun-video/har";

const capture = await loadHarCapture("C:/bun/tmp/test/www.crunchyroll.com.har");
const selected = capture.selectManifest({ kind: "dash" });
console.log(capture.summary);
```

The summary counts all entries, hosts, status classes, MIME types and parsed JSON bodies. Manifest metadata contains duration, representations and declared protection systems. Summary and resource descriptors omit cookies, headers, full URLs, query strings, key IDs, PSSH and response bodies. Keep the raw HAR in an ignored protected local directory.

`readManifest(entryIndex)` returns the validated manifest body for local processing. Treat this return value as sensitive: it can contain signed URLs and DRM metadata. Do not log it or return it directly to a browser dashboard. A local replay dashboard must rewrite resource references to opaque local routes and reject unsupported external references before serving a manifest.

`resourceForUrl(exactUrl)` looks up an available captured media resource and returns an opaque descriptor containing its entry index. `replayResource(entryIndex, range?)` serves that resource without exposing its original URL. `replay(exactUrl, range?)` is the equivalent direct lookup for trusted local code. Requests must match the captured source URL exactly, including its query. Replay excludes license endpoints, account API responses and unrelated assets.

Captured partial responses require a consistent `Content-Range` byte count. A requested range must match or fit entirely within one captured response; partial responses are never stitched together. Complete captured responses can satisfy a single bounded, suffix or open byte range; out-of-bounds requests return 416. Missing resources, unsupported multi-range requests and uncaptured byte ranges return `null`. Replay returns only content type, computed content length and range headers; captured cookies and authorization headers are never forwarded.

The adapter replays encrypted captured media unchanged. It does not acquire licenses, decrypt media, reconstruct missing segments or establish working browser playback. The caller remains responsible for compatible browser playback and the service's authorized license session.
