const BUN_VIDEO_PATHS = [
  "/api",
  "/app",
  "/episode",
  "/extension",
  "/health",
  "/labs",
  "/media",
  "/pwa",
  "/site",
  "/webgpu",
  "/workbench",
];
const ACCESS_JWKS_TTL = 5 * 60 * 1000;
let accessJwksCache;

function isBunVideoPath(path) {
  return BUN_VIDEO_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) || path === "/studio/app.js";
}

function unavailable() {
  return Response.json(
    { error: "bun_video_backend_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

function accessDenied() {
  return Response.json(
    { error: "access_required" },
    { status: 401, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

function isPublicBunVideoPath(method, path) {
  return ["GET", "HEAD"].includes(method) && ["/api/health", "/api/capabilities", "/api/youtube/search"].includes(path);
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")), character =>
    character.charCodeAt(0),
  );
}

async function accessJwks(issuer, fetchBackend) {
  if (accessJwksCache?.issuer === issuer && Date.now() - accessJwksCache.fetchedAt < ACCESS_JWKS_TTL)
    return accessJwksCache.keys;
  const response = await fetchBackend(
    new Request(`${issuer}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } }),
  );
  if (!response.ok) throw new Error("Access key endpoint unavailable");
  const document = await response.json();
  if (!Array.isArray(document?.keys)) throw new Error("Access key document invalid");
  accessJwksCache = { issuer, fetchedAt: Date.now(), keys: document.keys };
  return accessJwksCache.keys;
}

async function verifyAccessIdentity(request, env, fetchBackend) {
  if (!env.BUN_VIDEO_ACCESS_AUD || !env.BUN_VIDEO_ACCESS_ISSUER) return false;
  let issuer;
  try {
    issuer = new URL(env.BUN_VIDEO_ACCESS_ISSUER);
  } catch {
    return false;
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash
  )
    return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 8192) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    if (claims.iss !== issuer.origin) return false;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(env.BUN_VIDEO_ACCESS_AUD)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      (typeof claims.nbf === "number" && claims.nbf > now + 60)
    )
      return false;
    const email = request.headers.get("cf-access-authenticated-user-email");
    if (!email || typeof claims.email !== "string" || claims.email.toLowerCase() !== email.toLowerCase()) return false;
    let jwk = (await accessJwks(issuer.origin, fetchBackend)).find(key => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) {
      accessJwksCache = undefined;
      jwk = (await accessJwks(issuer.origin, fetchBackend)).find(key => key.kid === header.kid && key.kty === "RSA");
    }
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

/** @param {Request} request @param {import('./worker-configuration').Env} env @param {(request: Request) => Promise<Response>} [fetchBackend] */
export async function serveShowcase(request, env, fetchBackend = fetch) {
  const url = new URL(request.url);
  if (isBunVideoPath(url.pathname)) {
    if (!env.BUN_VIDEO_BACKEND_URL) return unavailable();
    let backend;
    try {
      backend = new URL(env.BUN_VIDEO_BACKEND_URL);
    } catch {
      return unavailable();
    }
    if (
      backend.protocol !== "https:" ||
      backend.host === url.host ||
      backend.username ||
      backend.password ||
      backend.pathname !== "/" ||
      backend.search ||
      backend.hash
    )
      return unavailable();
    if (
      !isPublicBunVideoPath(request.method, url.pathname) &&
      !(await verifyAccessIdentity(request, env, fetchBackend))
    )
      return accessDenied();
    const target = new URL(url.pathname + url.search, backend);
    try {
      const forwarded = new Request(target, request);
      forwarded.headers.set("x-forwarded-host", url.host);
      forwarded.headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      return await fetchBackend(forwarded);
    } catch (error) {
      console.error(
        JSON.stringify({ event: "bun-video-backend-failed", name: error instanceof Error ? error.name : "Error" }),
      );
      return unavailable();
    }
  }
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  let key;
  try {
    key = decodeURIComponent(url.pathname).slice(1) || "index.html";
  } catch {
    return new Response("Bad path", { status: 400 });
  }
  if (
    !/^[a-zA-Z0-9/_.,-]+$/.test(key) ||
    key.split("/").some(part => part === ".." || part === "." || part.startsWith("."))
  )
    return new Response("Not found", { status: 404 });
  if (["catalog", "shorts", "watch", "studio", "about", "playlist/saved", "series", "tools"].includes(key)) key = "index.html";
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    "Cache-Control": "public, max-age=300",
  });
  try {
    const objectKey = `${env.SHOWCASE_PREFIX}/${key}`;
    if (request.method === "HEAD") {
      const object = await env.SHOWCASE.head(objectKey);
      if (!object) return new Response("Not found", { status: 404, headers });
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Content-Length", String(object.size));
      return new Response(null, { headers });
    }
    const range = request.headers.has("Range") ? request.headers : undefined;
    const object = await env.SHOWCASE.get(objectKey, { onlyIf: request.headers, ...(range ? { range } : {}) });
    if (!object) return new Response("Not found", { status: 404, headers });
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    if (!("body" in object))
      return new Response(null, { status: request.headers.has("If-Match") ? 412 : 304, headers });
    let status = 200;
    if (request.headers.has("Range") && object.range && "offset" in object.range && "length" in object.range) {
      status = 206;
      headers.set(
        "Content-Range",
        `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      );
      headers.set("Content-Length", String(object.range.length));
    } else headers.set("Content-Length", String(object.size));
    if (key.startsWith("sources/")) {
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("Content-Disposition", "attachment");
    }
    return new Response(object.body, { status, headers });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "showcase-read-failed", name: error instanceof Error ? error.name : "Error" }),
    );
    return new Response("Temporarily unavailable", { status: 503, headers });
  }
}
export default { fetch: serveShowcase };
