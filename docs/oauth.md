# Owner-configured native OAuth

`@aphrody/bun-video/oauth` implements OAuth2 authorization-code PKCE using native
fetch, URLSearchParams, Web Crypto and private in-memory state. It does not infer
Crunchyroll authorization endpoints, application identifiers or application secrets.
The owner must have a registered authorized client and a matching registered redirect
URI. This generic client does not prove that Crunchyroll offers this grant to that
application; no password flow, cookie impersonation or DRM operation is introduced.

The client creates an unpredictable state and PKCE verifier for each authorization
attempt. Authorization uses the S256 challenge, while the verifier stays private until
the token exchange. Matching state is consumed before exchange, including denied,
expired or failed attempts. A retry requires a new authorization URL. Defaults are a
five-minute state lifetime, 30-second request deadline and at most eight pending
attempts. Each client owns its configuration, attempts and tokens.
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) specifies this PKCE exchange.

Supply `authorizationEndpoint`, `tokenEndpoint`, optional `revocationEndpoint`,
`clientId` and `redirectURI` to `createOAuthClient`. URLs require HTTPS; loopback
HTTP is accepted for registered local callbacks and local provider tests. Embedded
credentials and fragments are rejected. The configured callback origin and path,
plus any fixed query values, must match; duplicate state/code and unconfigured query
fields are rejected. Callback OAuth error details are discarded. Responses support
query-mode authorization code, not implicit grants, form-post callbacks, OpenID
Connect identity verification or automatic issuer discovery.

Use `await client.createAuthorizationURL({ scope: ownerApprovedScopes })` and send
that URL through the owner-approved login browser. The application routes the returned
callback URL to `await client.exchangeCallback(callbackURL)`. Both application and
provider must protect their callback channel. This library neither opens Chrome nor
handles browser login. Extra authorization parameters cannot override security
fields. No code verifier or client secret is included in the generated URL.

For public clients, `tokenEndpointAuthMethod` defaults to `none`. Confidential clients
must explicitly select `client_secret_basic` or `client_secret_post` and supply
their own `clientSecret`. Form POSTs carry the exchange/refresh/revocation fields;
Basic authentication encodes the client identifier and secret as form values.
Requests refuse redirects and support an optional caller AbortSignal. Errors expose
generic messages and HTTP status, without provider response bodies or transport
details. Token responses are validated before replacing private session state.
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) supplies the OAuth2 framework.

`session` and operation return values contain only authentication, expiry and refresh
availability. `withAccessToken` lets trusted application code use the access token
without adding a serializable token property:

```ts
import { createCrunchyrollClient } from "@aphrody/bun-video/crunchyroll";

const catalog = await oauth.withAccessToken((accessToken, tokenType) => {
  if (tokenType.toLowerCase() !== "bearer")
    throw new Error("The catalog requires a bearer token");
  return createCrunchyrollClient({
    accessToken,
    accountId: ownerAccountId,
    locale: "fr-FR",
  });
});
const catalogSession = await catalog.loginWithAccessToken();
```

Here `oauth` and `ownerAccountId` are application-owned values established through
authorized configuration/account identity. The historical catalog API's token and
CMS compatibility require separate live qualification. Do not log the callback,
authorization code, verifier, token callback arguments or confidential configuration.
The trusted callback can retain a token; the application must manage that retained
copy and refresh it when the OAuth session rotates.

`refresh()` sends the stored refresh token, validates the new token response and
retains the previous refresh token only when the provider omits a replacement.
Expired access tokens cannot be used through `withAccessToken`. No automatic network
refresh occurs when reading status. Exchange, refresh and revoke reject concurrent
session operations. `clear()` forgets all tokens and pending state; responses from a
request started before clearing cannot recreate the session.

`revoke()` requires the configured revocation endpoint and submits refresh and access
tokens separately. A successful body is ignored. Local tokens/state are cleared even
when remote revocation fails, and that failure is reported. An error therefore does
not confirm remote invalidation. `clear()` alone performs no server revocation.
The client does not persist credentials or tokens to disk.
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) defines token revocation.

Local tests use synthetic tokens and Bun.serve on port zero to verify PKCE exchange,
state replay/expiry, callback matching, rotation, revocation, isolated clients,
client authentication, redacted failures, redirect refusal, cancellation and deadlines.
These tests do not establish live provider authorization, licensed media playback or
registry publication readiness.
