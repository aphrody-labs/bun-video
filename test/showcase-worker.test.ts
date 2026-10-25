import { expect, test } from "bun:test";
import { serveShowcase } from "../showcase/worker.js";

test("showcase maps the root into its versioned R2 namespace and streams bytes", async () => {
  const keys: string[] = [];
  const options: unknown[] = [];
  const response = await serveShowcase(new Request("https://video.aphrody.com/"), {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get(key: string, requestOptions: unknown) {
        keys.push(key);
        options.push(requestOptions);
        return {
          size: 3,
          range: { offset: 0, length: 3 },
          httpEtag: '"abc"',
          body: new Blob([new Uint8Array([0, 255, 42])]).stream(),
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", "image/png");
          },
        };
      },
    },
  });
  expect(keys).toEqual(["showcase/test-v1/index.html"]);
  expect(options).toEqual([{ onlyIf: new Headers() }]);
  expect(response.status).toBe(200);
  expect([...(await response.bytes())]).toEqual([0, 255, 42]);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Length")).toBe("3");
  expect(response.headers.get("Content-Range")).toBeNull();
});

test("video product routes serve the same app shell for client-side navigation", async () => {
  const keys: string[] = [];
  const env = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get(key: string) {
        keys.push(key);
        return {
          size: 4,
          httpEtag: '"app"',
          body: new Blob(["app!"]).stream(),
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", "text/html");
          },
        };
      },
    },
  };
  for (const path of ["/catalog", "/shorts", "/watch?v=remotion-orbital", "/studio", "/about", "/playlist/saved"]) {
    const response = await serveShowcase(new Request(`https://video.aphrody.com${path}`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
  }
  expect(keys).toEqual(Array(6).fill("showcase/test-v1/index.html"));
});

test("same-origin Bun APIs and protected workbench proxy to the configured Bun server", async () => {
  const issuer = "https://aphrody.cloudflareaccess.com";
  const audience = "video-app-audience";
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "test-access-key",
    alg: "RS256",
    use: "sig",
  };
  const encode = (value: Uint8Array) =>
    btoa(Array.from(value, byte => String.fromCharCode(byte)).join(""))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-access-key", typ: "JWT" })));
  const claims = encode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuer,
        aud: [audience],
        exp: Math.floor(Date.now() / 1000) + 300,
        email: "user@example.com",
      }),
    ),
  );
  const signed = new TextEncoder().encode(`${header}.${claims}`);
  const signature = encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, signed)));
  const token = `${header}.${claims}.${signature}`;
  let forwarded: Request | undefined;
  const response = await serveShowcase(
    new Request("https://video.aphrody.com/api/pipeline/run?mode=full", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-authenticated-user-email": "user@example.com",
        "cf-access-jwt-assertion": token,
      },
      body: JSON.stringify({ media: "clip.mp4" }),
    }),
    {
      BUN_VIDEO_BACKEND_URL: "https://bun-video-origin.aphrody.app",
      BUN_VIDEO_ACCESS_ISSUER: issuer,
      BUN_VIDEO_ACCESS_AUD: audience,
      SHOWCASE_PREFIX: "showcase/test-v1",
      SHOWCASE: {
        async head() {
          throw new Error("Dynamic requests must not read R2");
        },
        async get() {
          throw new Error("Dynamic requests must not read R2");
        },
      },
    },
    async request => {
      if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [publicKey] });
      forwarded = request;
      return Response.json({ route: "bun-video" }, { status: 207 });
    },
  );
  expect(forwarded?.url).toBe("https://bun-video-origin.aphrody.app/api/pipeline/run?mode=full");
  expect(forwarded?.method).toBe("POST");
  expect(forwarded?.headers.get("x-forwarded-host")).toBe("video.aphrody.com");
  expect(forwarded?.headers.get("x-forwarded-proto")).toBe("https");
  expect(forwarded?.headers.get("cf-access-jwt-assertion")).toBe(token);
  expect(await forwarded?.json()).toEqual({ media: "clip.mp4" });
  expect(response.status).toBe(207);
  expect(await response.json()).toEqual({ route: "bun-video" });

  // A signed token without an email claim cannot vouch for the forwarded email header.
  const anonymous = encode(
    new TextEncoder().encode(
      JSON.stringify({ iss: issuer, aud: [audience], exp: Math.floor(Date.now() / 1000) + 300 }),
    ),
  );
  const anonymousSignature = encode(
    new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${header}.${anonymous}`),
      ),
    ),
  );
  let spoofed = false;
  const denied = await serveShowcase(
    new Request("https://video.aphrody.com/workbench", {
      headers: {
        "cf-access-authenticated-user-email": "admin@example.com",
        "cf-access-jwt-assertion": `${header}.${anonymous}.${anonymousSignature}`,
      },
    }),
    {
      BUN_VIDEO_BACKEND_URL: "https://bun-video-origin.aphrody.app",
      BUN_VIDEO_ACCESS_ISSUER: issuer,
      BUN_VIDEO_ACCESS_AUD: audience,
      SHOWCASE_PREFIX: "showcase/test-v1",
      SHOWCASE: {
        async head() {
          return null;
        },
        async get() {
          return null;
        },
      },
    },
    async request => {
      if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [publicKey] });
      spoofed = true;
      return new Response(null, { status: 500 });
    },
  );
  expect(await denied.json()).toEqual({ error: "access_required" });
  expect(denied.status).toBe(401);
  expect(spoofed).toBe(false);
});

test("private Bun routes reject spoofed Access headers before proxying", async () => {
  let proxied = false;
  const response = await serveShowcase(
    new Request("https://video.aphrody.com/workbench", {
      headers: {
        "cf-access-authenticated-user-email": "user@example.com",
        "cf-access-jwt-assertion": "not-a-signed-token",
      },
    }),
    {
      BUN_VIDEO_BACKEND_URL: "https://bun-video-origin.aphrody.app",
      BUN_VIDEO_ACCESS_ISSUER: "https://aphrody.cloudflareaccess.com",
      BUN_VIDEO_ACCESS_AUD: "video-app-audience",
      SHOWCASE_PREFIX: "showcase/test-v1",
      SHOWCASE: {
        async head() {
          return null;
        },
        async get() {
          return null;
        },
      },
    },
    async () => {
      proxied = true;
      throw new Error("Invalid Access credentials must not reach the backend");
    },
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "access_required" });
  expect(proxied).toBe(false);
});

test("dynamic Bun surfaces fail closed when the backend origin is not configured", async () => {
  const response = await serveShowcase(new Request("https://video.aphrody.com/workbench"), {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        throw new Error("Unconfigured requests must not read R2");
      },
      async get() {
        throw new Error("Unconfigured requests must not read R2");
      },
    },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "bun_video_backend_unavailable" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("dynamic Bun backend must use a bare HTTPS origin", async () => {
  const result = await serveShowcase(
    new Request("https://video.aphrody.com/api/health"),
    {
      BUN_VIDEO_BACKEND_URL: "http://127.0.0.1:8787",
      SHOWCASE_PREFIX: "showcase/test-v1",
      SHOWCASE: {
        async head() {
          throw new Error("Invalid origins must not read R2");
        },
        async get() {
          throw new Error("Invalid origins must not read R2");
        },
      },
    },
    async () => {
      throw new Error("Invalid origins must not be fetched");
    },
  );
  expect(result.status).toBe(503);
});

test("showcase serves HEAD and byte ranges without buffering the object", async () => {
  const object = {
    size: 100,
    httpEtag: '"abc"',
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "audio/wav");
    },
  };
  const env = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return object;
      },
      async get(_key: string, options: { range?: Headers }) {
        expect(options.range).toBeInstanceOf(Headers);
        return { ...object, range: { offset: 10, length: 3 }, body: new Blob(["abc"]).stream() };
      },
    },
  };
  const head = await serveShowcase(new Request("https://video.aphrody.com/native/audio.wav", { method: "HEAD" }), env);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("Content-Length")).toBe("100");
  const range = await serveShowcase(
    new Request("https://video.aphrody.com/native/audio.wav", { headers: { Range: "bytes=10-12" } }),
    env,
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("Content-Range")).toBe("bytes 10-12/100");
  expect(await range.text()).toBe("abc");
});

test("showcase rejects writes and hidden paths before touching R2", async () => {
  const env = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get() {
        throw new Error("R2 should not be read");
      },
    },
  };
  expect((await serveShowcase(new Request("https://video.aphrody.com/.env"), env)).status).toBe(404);
  expect((await serveShowcase(new Request("https://video.aphrody.com/%5cprivate"), env)).status).toBe(404);
  expect((await serveShowcase(new Request("https://video.aphrody.com/%zz"), env)).status).toBe(400);
  const write = await serveShowcase(new Request("https://video.aphrody.com/", { method: "POST" }), env);
  expect(write.status).toBe(405);
  expect(write.headers.get("Allow")).toBe("GET, HEAD");
});

test("showcase handles absent and unchanged objects and forces source downloads", async () => {
  const absent = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get() {
        return null;
      },
    },
  };
  expect((await serveShowcase(new Request("https://video.aphrody.com/absent"), absent)).status).toBe(404);
  const unchanged = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get() {
        return { size: 0, httpEtag: '"abc"', writeHttpMetadata() {} };
      },
    },
  };
  expect(
    (
      await serveShowcase(
        new Request("https://video.aphrody.com/app.js", { headers: { "If-None-Match": '"abc"' } }),
        unchanged,
      )
    ).status,
  ).toBe(304);
  const source = {
    SHOWCASE_PREFIX: "showcase/test-v1",
    SHOWCASE: {
      async head() {
        return null;
      },
      async get() {
        return { size: 4, httpEtag: '"abc"', body: new Blob(["code"]).stream(), writeHttpMetadata() {} };
      },
    },
  };
  const response = await serveShowcase(new Request("https://video.aphrody.com/sources/artwork.tsx"), source);
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe("attachment");
});
