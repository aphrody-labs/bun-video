import { expect, spyOn, test } from "bun:test";
import { createOAuthClient, OAuthClient, OAuthError, type OAuthClientConfig } from "../src/oauth";

interface RequestRecord {
  path: string;
  method: string;
  body: URLSearchParams;
  authorization: string | null;
  contentType: string | null;
}

async function withProvider(
  run: (config: OAuthClientConfig, calls: RequestRecord[]) => Promise<void>,
  response?: (request: Request, call: RequestRecord) => Response | Promise<Response>,
) {
  const calls: RequestRecord[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call = {
        path: new URL(request.url).pathname,
        method: request.method,
        body: new URLSearchParams(await request.clone().text()),
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
      };
      calls.push(call);
      if (response) return response(request, call);
      if (call.path === "/revoke") return new Response("", { status: 200 });
      return Response.json({
        access_token: "local-access",
        token_type: "Bearer",
        refresh_token: "local-refresh",
        expires_in: 3600,
      });
    },
  });
  const origin = server.url.origin;
  try {
    await run(
      {
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        revocationEndpoint: `${origin}/revoke`,
        clientId: "owner-local-client",
        redirectURI: `${origin}/callback?flow=owner`,
      },
      calls,
    );
  } finally {
    await server.stop(true);
  }
}

async function callback(api: OAuthClient, config: OAuthClientConfig, code = "local-code") {
  const authorization = new URL(await api.createAuthorizationURL({ scope: ["catalog", "offline_access"] }));
  const callback = new URL(config.redirectURI);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", code);
  return { authorization, callback };
}

test("authorization code S256 PKCE exchange uses native fetch and private tokens", async () => {
  await withProvider(async (config, calls) => {
    const api = createOAuthClient(config);
    const urls = await callback(api, config);
    expect(urls.authorization.searchParams.get("response_type")).toBe("code");
    expect(urls.authorization.searchParams.get("client_id")).toBe(config.clientId);
    expect(urls.authorization.searchParams.get("redirect_uri")).toBe(config.redirectURI);
    expect(urls.authorization.searchParams.get("scope")).toBe("catalog offline_access");
    expect(urls.authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(urls.authorization.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(urls.authorization.searchParams.has("code_verifier")).toBe(false);
    expect(calls).toHaveLength(0);
    const session = await api.exchangeCallback(urls.callback.href);
    expect(session).toEqual({
      authenticated: true,
      refreshable: true,
      expiresAt: expect.any(Number),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.contentType).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.authorization).toBeNull();
    expect(calls[0]!.body.get("grant_type")).toBe("authorization_code");
    expect(calls[0]!.body.get("code")).toBe("local-code");
    expect(calls[0]!.body.get("redirect_uri")).toBe(config.redirectURI);
    expect(calls[0]!.body.get("client_id")).toBe(config.clientId);
    const verifier = calls[0]!.body.get("code_verifier")!;
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(urls.authorization.searchParams.get("code_challenge")!);
    expect(await api.withAccessToken((token, type) => ({ correct: token === "local-access", type }))).toEqual({
      correct: true,
      type: "Bearer",
    });
    expect(JSON.stringify(api)).toBe("{}");
    expect(JSON.stringify(api.session)).not.toContain("local-access");
    expect(JSON.stringify(api.session)).not.toContain("local-refresh");
    await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("already used");
    expect(calls).toHaveLength(1);
  });
});

test("callback matching rejects other origins, paths, fixed query values, duplicate response fields and unknown state", async () => {
  await withProvider(async (config, calls) => {
    const api = createOAuthClient(config);
    const urls = await callback(api, config);
    for (const change of [
      (u: URL) => {
        u.hostname = "localhost";
      },
      (u: URL) => {
        u.pathname = "/other";
      },
      (u: URL) => {
        u.searchParams.set("flow", "other");
      },
      (u: URL) => {
        u.searchParams.append("state", "duplicate");
      },
      (u: URL) => {
        u.searchParams.set("unconfigured", "extra");
      },
    ]) {
      const altered = new URL(urls.callback);
      change(altered);
      await expect(api.exchangeCallback(altered.href)).rejects.toBeInstanceOf(OAuthError);
    }
    const wrong = new URL(urls.callback);
    wrong.searchParams.set("state", "unknown");
    await expect(api.exchangeCallback(wrong.href)).rejects.toThrow("unknown");
    expect(calls).toHaveLength(0);
    const duplicateCode = new URL(urls.callback);
    duplicateCode.searchParams.append("code", "duplicate");
    await expect(api.exchangeCallback(duplicateCode.href)).rejects.toThrow("one authorization code");
    await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("already used");
    expect(calls).toHaveLength(0);
  });
});

test("expired states and provider denial are consumed without disclosing callback errors", async () => {
  await withProvider(async (config, calls) => {
    const api = createOAuthClient({ ...config, stateTTLms: 1000 });
    const expired = await callback(api, config);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
    try {
      await expect(api.exchangeCallback(expired.callback.href)).rejects.toThrow("expired");
    } finally {
      clock.mockRestore();
    }
    await expect(api.exchangeCallback(expired.callback.href)).rejects.toThrow("already used");
    const denied = await callback(api, config);
    denied.callback.searchParams.delete("code");
    denied.callback.searchParams.set("error", "private-provider-error");
    denied.callback.searchParams.set("error_description", "private-description");
    await expect(api.exchangeCallback(denied.callback.href)).rejects.toThrow("OAuth authorization was denied");
    await expect(api.exchangeCallback(denied.callback.href)).rejects.toThrow("already used");
    expect(calls).toHaveLength(0);
  });
});

test("refresh rotates tokens and revoke sends both token types before forgetting credentials", async () => {
  let refreshCount = 0;
  await withProvider(
    async (config, calls) => {
      const api = createOAuthClient(config);
      const urls = await callback(api, config);
      await api.exchangeCallback(urls.callback.href);
      await api.refresh();
      expect(calls[1]!.body.get("grant_type")).toBe("refresh_token");
      expect(calls[1]!.body.get("refresh_token")).toBe("refresh-0");
      expect(await api.withAccessToken(token => token === "access-1")).toBe(true);
      await api.refresh();
      expect(calls[2]!.body.get("refresh_token")).toBe("refresh-1");
      await api.revoke();
      expect(calls[3]!.body.get("token_type_hint")).toBe("refresh_token");
      expect(calls[3]!.body.get("token")).toBe("refresh-1");
      expect(calls[4]!.body.get("token_type_hint")).toBe("access_token");
      expect(calls[4]!.body.get("token")).toBe("access-2");
      expect(api.session).toEqual({
        authenticated: false,
        refreshable: false,
        expiresAt: undefined,
      });
      await expect(api.withAccessToken(() => true)).rejects.toThrow("no usable access token");
    },
    (_request, call) => {
      if (call.path === "/revoke") return new Response("body ignored", { status: 200 });
      if (call.body.get("grant_type") === "refresh_token") refreshCount++;
      return Response.json({
        access_token: `access-${refreshCount}`,
        token_type: "Bearer",
        ...(refreshCount < 2 ? { refresh_token: `refresh-${refreshCount}` } : {}),
        expires_in: 3600,
      });
    },
  );
});

test("confidential Basic and POST credentials remain outside authorization URLs", async () => {
  await withProvider(async (config, calls) => {
    for (const method of ["client_secret_basic", "client_secret_post"] as const) {
      const api = createOAuthClient({
        ...config,
        clientId: "owner client",
        clientSecret: "local:secret",
        tokenEndpointAuthMethod: method,
      });
      const urls = await callback(api, config);
      expect(urls.authorization.searchParams.has("client_secret")).toBe(false);
      expect(urls.authorization.searchParams.has("code_verifier")).toBe(false);
      await api.exchangeCallback(urls.callback.href);
      const call = calls.at(-1)!;
      if (method === "client_secret_basic") {
        expect(atob(call.authorization!.slice("Basic ".length))).toBe("owner+client:local%3Asecret");
        expect(call.body.has("client_secret")).toBe(false);
      } else {
        expect(call.authorization).toBeNull();
        expect(call.body.get("client_secret")).toBe("local:secret");
      }
    }
  });
});

test("independent clients isolate states; reserved fields and insecure configuration fail locally", async () => {
  await withProvider(async (config, calls) => {
    const first = createOAuthClient(config);
    const second = createOAuthClient(config);
    const urls = await callback(first, config);
    await expect(second.exchangeCallback(urls.callback.href)).rejects.toThrow("unknown");
    await first.exchangeCallback(urls.callback.href);
    expect(first.session.authenticated).toBe(true);
    expect(second.session.authenticated).toBe(false);
    expect(calls).toHaveLength(1);
    for (const key of [
      "state",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_verifier",
      "client_secret",
      "response_type",
    ]) {
      await expect(first.createAuthorizationURL({ extra: { [key]: "override" } })).rejects.toThrow("cannot override");
    }
    expect(() => createOAuthClient({ ...config, clientId: "" })).toThrow("owner-provided");
    expect(() => createOAuthClient({ ...config, tokenEndpoint: "http://provider.example/token" })).toThrow("loopback");
    expect(() => createOAuthClient({ ...config, tokenEndpoint: "https://user:secret@provider.example/token" })).toThrow(
      "embedded credentials",
    );
    expect(() => createOAuthClient({ ...config, clientSecret: "local" })).toThrow("explicit method");
    expect(() => createOAuthClient({ ...config, tokenEndpointAuthMethod: "client_secret_basic" })).toThrow(
      "client secret",
    );
    expect(() => createOAuthClient({ ...config, stateTTLms: 0 })).toThrow("durations");
    expect(() => createOAuthClient({ ...config, redirectURI: `${config.redirectURI}&state=reserved` })).toThrow(
      "reserved response",
    );
  });
});

test("token HTTP, JSON and OAuth errors are redacted and each exchange remains single use", async () => {
  for (const response of [
    new Response("private-secret", { status: 401 }),
    Response.json({ error: "private-secret" }),
    new Response("private-secret"),
    Response.json({ access_token: "private-secret", token_type: "Bearer", expires_in: -1 }),
  ]) {
    await withProvider(
      async config => {
        const api = createOAuthClient(config);
        const urls = await callback(api, config);
        try {
          await api.exchangeCallback(urls.callback.href);
          throw new Error("Expected OAuth failure");
        } catch (error) {
          expect(error).toBeInstanceOf(OAuthError);
          expect((error as Error).message).not.toContain("private-secret");
        }
        await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("already used");
        expect(api.session.authenticated).toBe(false);
      },
      () => response.clone(),
    );
  }
});

test("cross-origin endpoint redirect never forwards a code, verifier or client secret", async () => {
  let destinationCalls = 0;
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      destinationCalls++;
      return Response.json({});
    },
  });
  try {
    await withProvider(
      async config => {
        const api = createOAuthClient({
          ...config,
          clientSecret: "local",
          tokenEndpointAuthMethod: "client_secret_basic",
        });
        const urls = await callback(api, config);
        await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("redirects are refused");
        expect(destinationCalls).toBe(0);
      },
      () => Response.redirect(destination.url, 307),
    );
  } finally {
    await destination.stop(true);
  }
});

test("expired access token cannot be used; public cancellation aborts without exposing transport detail", async () => {
  await withProvider(
    async config => {
      const api = createOAuthClient(config);
      const urls = await callback(api, config);
      await api.exchangeCallback(urls.callback.href);
      await expect(api.withAccessToken(() => true)).rejects.toThrow("no usable access token");
      expect(api.session.refreshable).toBe(true);
    },
    () =>
      Response.json({
        access_token: "local",
        token_type: "Bearer",
        refresh_token: "refresh",
        expires_in: 0,
      }),
  );
  await withProvider(async (config, calls) => {
    const api = createOAuthClient({ ...config, signal: AbortSignal.abort("private-abort-reason") });
    const urls = await callback(api, config);
    await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("aborted or timed out");
    expect(calls).toHaveLength(0);
  });
});

test("clear during in-flight exchange cannot resurrect tokens or pending authorization", async () => {
  let resolveResponse!: (response: Response) => void;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => {
    requestStarted = resolve;
  });
  await withProvider(
    async config => {
      const api = createOAuthClient(config);
      const urls = await callback(api, config);
      const exchange = api.exchangeCallback(urls.callback.href);
      await started;
      await expect(api.refresh()).rejects.toThrow("already in progress");
      api.clear();
      resolveResponse(Response.json({ access_token: "local", token_type: "Bearer" }));
      await expect(exchange).rejects.toThrow("cleared during");
      expect(api.session.authenticated).toBe(false);
      await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("already used");
    },
    () =>
      new Promise<Response>(resolve => {
        resolveResponse = resolve;
        requestStarted();
      }),
  );
});

test("request deadline terminates a stalled provider response", async () => {
  await withProvider(
    async config => {
      const api = createOAuthClient({ ...config, timeoutMs: 10 });
      const urls = await callback(api, config);
      await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("aborted or timed out");
      await expect(api.exchangeCallback(urls.callback.href)).rejects.toThrow("already used");
    },
    () => new Promise<Response>(() => {}),
  );
});

test("failed remote revocation clears local tokens while reporting unconfirmed remote status", async () => {
  await withProvider(
    async config => {
      const api = createOAuthClient(config);
      const urls = await callback(api, config);
      await api.exchangeCallback(urls.callback.href);
      await expect(api.revoke()).rejects.toThrow("OAuth endpoint request failed (503)");
      expect(api.session.authenticated).toBe(false);
      expect(api.session.refreshable).toBe(false);
    },
    (_request, call) =>
      call.path === "/revoke"
        ? new Response("private-provider-failure", { status: 503 })
        : Response.json({ access_token: "local", token_type: "Bearer", refresh_token: "refresh" }),
  );
});
