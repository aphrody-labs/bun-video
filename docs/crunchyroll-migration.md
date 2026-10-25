# Crunchyroll client migration

## Observed watchlist metadata

`src/crunchyroll-watchlist.ts` accepts official series and watch URLs observed in
the owner's authenticated watchlist, including movie cards. The synchronous
`registerObservedCrunchyrollWatchlist(catalog, entries)` registers public metadata
without network access or authentication. Its scope is only the supplied observed
references; expansion remains pending. Titles are optional observations, not a
claim of complete account inventory. Query strings, fragments and slugs are omitted
from canonical stored URLs.

`importCrunchyrollWatchlist(catalog, entries,
{ clientFactory })` reuses `getAnime`, `getSeasons` and `getEpisodes`; the factory
can reuse `crunchyrollClientFactory`. No watchlist or individual movie/episode
metadata endpoint is assumed. Watch references remain in the catalog and in the
returned `pendingVideos`; their presence does not qualify playable media.

The import validates the complete supplied metadata before one transaction in
`VideoCatalog`. Stable source IDs prevent duplicate imports and preserve private
media references, provider qualification and existing jobs. Series use
`crunchyroll:series:<id>` and watch references use `crunchyroll:video:<id>`;
historical episode/movie identities and matching provider URL identities are
retained. Both registration paths share one insertion owner. Responses with missing totals or incomplete
item lists require verified provider pagination. Returned episode IDs and
official URLs can feed the existing episode workflow; metadata import does not
establish playable media, subtitles or CDN publication.

The existing `bun-video crunchyroll` CLI accepts:

```text
bun-video crunchyroll watchlist metadata observed.json --catalog <catalog.sqlite>
bun-video crunchyroll watchlist import observed.json --catalog <catalog.sqlite> --timeout 300000
```

Input is a UTF-8 JSON array of `{ "url": "official URL", "title": "optional observed title" }`,
limited to 4 MiB and 10000 entries. The catalog defaults to the existing private
`VideoCatalog` location. `metadata` needs no private configuration. `import` uses
the existing `BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN`, account and locale configuration;
credentials are never CLI arguments. Import validates all responses before its
transaction. A provider authentication failure does not remove observations
registered earlier with `metadata`. No jobs, media extraction or uploads are
started by either command.

## Stateless metadata API and CLI

`@aphrody/bun-video/crunchyroll/api` exports `createCrunchyrollApi`, a Fetch
handler suitable for a Bun server or serverless Bun deployment. It creates no
upstream client for public `/health` and `/v1/watch?url=...` requests. The watch
route parses an official URL and omits its query/hash; it does not fetch a video
or establish playback.

Private GET routes require a separately configured API bearer token:
`/v1/anime/:id`, `/v1/anime/:id/seasons`, `/v1/seasons/:id/episodes`, and
`/v1/search?q=...`. Their injected `clientFactory(signal)` reuses the existing
client's metadata methods. `crunchyrollClientFactory` creates a fresh client
from caller-owned upstream options and authenticates its supplied access token.
API authorization is never forwarded as upstream authorization.

Missing API authorization returns 401; missing configured metadata provider
returns 503. Upstream failures expose a stable error code and optional numeric
status, never a response body or credentials. Requests have a bounded deadline,
propagate cancellation to the factory and return `Cache-Control: no-store`.

A Bun serverless entry can export the handler directly. Supply deployment-owned
tokens to the factory explicitly; the public-only entry needs no credentials:

```ts
import { createCrunchyrollApi } from "@aphrody/bun-video/crunchyroll/api";

export default { fetch: createCrunchyrollApi() };
// For a Bun HTTP server: Bun.serve({ fetch: createCrunchyrollApi() });
```

This adapter requires a Bun runtime; it does not provision a deployment or a
browser/media provider.

```sh
bun-video crunchyroll watch https://www.crunchyroll.com/fr/watch/G4VUQ9QWX/fixture
bun-video crunchyroll serve --hostname 127.0.0.1 --port 3000
```

Serve defaults to public parsing/health only. Private metadata requires explicit
`BUN_VIDEO_CRUNCHYROLL_API_TOKEN` and upstream
`BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN` configuration. Optional account ID and locale
use the corresponding `BUN_VIDEO_CRUNCHYROLL_ACCOUNT_ID` and
`BUN_VIDEO_CRUNCHYROLL_LOCALE` variables. Keep values in the deployment's isolated
secret configuration. This CLI does not open private Chrome profiles, import
cookies/passwords, upload protected stores or supply application credentials.

The API does not implement DRM, license acquisition or media playback. Generated
routes and synthetic tests are separate from qualification against an actual
authorized Crunchyroll account and supported browser environment.

## Private export to Shenron

`bun packages/bun-video/src/apps/crunchyroll-shenron-watchlist.ts` reads cookies from
the encrypted Windows vault, fetches `/fr/watchlist` with redirects restricted to
Crunchyroll, and writes observed references and titles to
`C:\shenron\data\home\imports`. This private metadata artifact is not ingested
into Shenron's database or editorial catalog. Cookie values are never exported.
An HTTP 401/403, a page with no references, or an access error stops the pipeline
without creating a file. The report marks authentication as unqualified: page
content alone does not prove which account returned it.

The native TypeScript client in `src/crunchyroll.ts` implements every public function
from the inspected MIT-licensed `crunchyroll.js` 1.1.1 migration baseline: `login`, `getProfile`,
`getAnime`, `getSeasons`, `getEpisodes`, `getCategories`, `getRate`, `getSimilar`,
`search`, `getAllAnimes`, and `getNewsFeed`. `client` is an isolated default instance;
`createCrunchyrollClient` creates independently configured instances. The implementation
uses native fetch and URLSearchParams, without CommonJS, the deprecated `request`
dependency, Buffer conversion or String prototype modifications. Upstream license
and attribution remain in the license notice below. The deprecated upstream
package and its `request` dependency are removed from production dependencies.

Construct a client with caller-owned `basicAuthorization` for password login,
or with `accessToken` and optional `accountId` followed by `loginWithAccessToken()`.
No upstream embedded application credentials are bundled. The unconfigured default
facade cannot log in until the caller instead creates a configured client.
`client.client` and login results expose a safe status snapshot rather than tokens,
CMS signatures or saved passwords. Error messages omit response bodies. Credentials
are private instance state and used only on the configured HTTPS origin; plain HTTP
is accepted only for loopback tests. Redirects are refused and requests support a
caller AbortSignal and a finite timeout (30 seconds by default).

The endpoint paths, English default locale, signed CMS query fields, pagination
defaults (`start=0`, `n=10`, `sort_by=alphabetical`) and four-minute authentication
refresh follow upstream. Query values and path IDs are encoded. Refresh now occurs
before constructing CMS paths, retains the selected locale and deduplicates parallel
refreshes. Access-token sessions refresh CMS authorization with the supplied token;
an expired token must be replaced by the caller. Password sessions repeat the
upstream password grant. This is a client API migration, not the official Crunchyroll
SDK, and does not promise that historical beta API endpoints currently support that
grant or those content routes.

For French requests, construct the client with `locale: "fr-FR"`. Password login
without a locale argument preserves this configured locale; an explicit third
argument overrides it. Clients without locale configuration retain `en-US`.
Search encodes accented and multilingual text without changing its value, and
paginated catalog requests retain the selected locale. This is verified on a
loopback API fixture; availability on current Crunchyroll endpoints remains a
separate live gate.

The local-server test covers all public operations, OAuth form requests, pagination,
query encoding, isolated credentials, refresh, HTTP/API/JSON errors, redirects,
cancellation and deadlines. It neither uses the user's cookies nor contacts the
public service, retrieves video media, requests licenses or alters DRM. Live
authorized account playback and registry publication require separate qualification.

## Upstream license

MIT License

Copyright (c) 2022 Mssjim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Long-running service

`@aphrody/bun-video/crunchyroll/service` exports `createCrunchyrollService`, and
`bun-video crunchyroll daemon --entries <observed.json> [--catalog <path>] [--interval <60..86400 s>]`
runs it. One process holds four layers:

- Crawler: a sync loop that re-reads the observed references every cycle and registers them in the video
  catalog. With `BUN_VIDEO_CRUNCHYROLL_ACCESS_TOKEN` configured, series are expanded to seasons and episodes
  through the existing client. A cycle is bounded by a timeout, never overlaps another, and backs off
  exponentially (up to six hours) after failures; only a stable error code is retained.
- Indexer: the catalog itself. `GET /v1/index/sources?kind=series|video&limit=N` (service token required) lists
  the registered Crunchyroll sources.
- API: the metadata routes of `createCrunchyrollApi` plus `GET /health`, which reports the sync state and answers
  503 when no cycle succeeded within the longer of three intervals and the backoff cap.
- Resolver: `GET /v1/resolve?url=<official URL>` or `?id=<content id>` returns the canonical URL, the catalog
  entry and, when the deployment injects a `shenron(contentId)` mapping, the Shenron wiki episode ID.

The entries file is the only input that carries account data. This service performs no sign-in and does not
read cookies; producing the observed references from an authenticated watchlist is a separate step, and the
watchlist page is rendered client-side, so a plain HTTP fetch of it returns no entries. Qualified status: the sync,
index, health and resolver behaviour is covered by `test/crunchyroll-service.test.ts` with injected clients and a
local run of the daemon; no live Crunchyroll account call has been qualified. `infra/systemd/bun-video-crunchyroll.service`
is a hardened unit template for a 24/7 deployment.
