// SPDX-License-Identifier: Apache-2.0

export interface OAuthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  redirectURI: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  stateTTLms?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OAuthSession {
  authenticated: boolean;
  expiresAt?: number;
  refreshable: boolean;
}

export interface AuthorizationOptions {
  scope?: string[];
  extra?: Record<string, string>;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

function checkedURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("OAuth configuration requires an absolute URL");
  }
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol))
    throw new OAuthError("OAuth URLs must use HTTPS without embedded credentials or fragments");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new OAuthError("OAuth HTTP is allowed only on loopback");
  return url;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function formValue(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Owner-configured OAuth2 public/confidential client; never discovers or invents service credentials. */
export class OAuthClient {
  readonly #config: OAuthClientConfig;
  readonly #authorization: URL;
  readonly #tokenEndpoint: URL;
  readonly #revocation?: URL;
  readonly #redirect: URL;
  #tokens?: TokenSet;
  #pending = new Map<string, { verifier: string; expiresAt: number }>();
  #busy = false;
  #generation = 0;

  constructor(config: OAuthClientConfig) {
    if (!config.clientId?.trim()) throw new OAuthError("An owner-provided OAuth clientId is required");
    this.#authorization = checkedURL(config.authorizationEndpoint);
    this.#tokenEndpoint = checkedURL(config.tokenEndpoint);
    this.#revocation = config.revocationEndpoint ? checkedURL(config.revocationEndpoint) : undefined;
    this.#redirect = checkedURL(config.redirectURI);
    for (const reserved of ["code", "state", "error", "error_description", "error_uri", "iss"]) {
      if (this.#redirect.searchParams.has(reserved))
        throw new OAuthError("OAuth redirect URI contains a reserved response parameter");
    }
    const method = config.tokenEndpointAuthMethod ?? "none";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method))
      throw new OAuthError("Unsupported OAuth client authentication method");
    if (method === "none" && config.clientSecret !== undefined)
      throw new OAuthError("Select an explicit method for confidential client authentication");
    if (method !== "none" && !config.clientSecret)
      throw new OAuthError("The selected OAuth authentication method requires a client secret");
    for (const duration of [config.stateTTLms ?? 300_000, config.timeoutMs ?? 30_000]) {
      if (!Number.isSafeInteger(duration) || duration <= 0)
        throw new OAuthError("OAuth durations must be positive safe integers");
    }
    this.#config = { ...config, tokenEndpointAuthMethod: method };
  }

  get session(): OAuthSession {
    return {
      authenticated: !!this.#tokens && (this.#tokens.expiresAt === undefined || this.#tokens.expiresAt > Date.now()),
      expiresAt: this.#tokens?.expiresAt,
      refreshable: !!this.#tokens?.refreshToken,
    };
  }

  clear(): void {
    this.#generation++;
    this.#tokens = undefined;
    this.#pending.clear();
  }

  async createAuthorizationURL(options: AuthorizationOptions = {}): Promise<string> {
    const now = Date.now();
    for (const [state, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(state);
    if (this.#pending.size >= 8) throw new OAuthError("Too many pending OAuth authorization attempts");
    const url = new URL(this.#authorization);
    const reserved = new Set([
      "response_type",
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "client_secret",
      "code_verifier",
    ]);
    for (const [key, value] of Object.entries(options.extra ?? {})) {
      if (reserved.has(key))
        throw new OAuthError("Additional authorization parameters cannot override OAuth security fields");
      url.searchParams.set(key, value);
    }
    if (options.scope?.some(scope => !scope || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)))
      throw new OAuthError("Invalid OAuth scope token");
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const generation = this.#generation;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    if (generation !== this.#generation) throw new OAuthError("OAuth authorization attempt was cleared");
    if (this.#pending.size >= 8) throw new OAuthError("Too many pending OAuth authorization attempts");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", this.#config.redirectURI);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", base64url(new Uint8Array(digest)));
    if (options.scope?.length) url.searchParams.set("scope", options.scope.join(" "));
    else url.searchParams.delete("scope");
    url.searchParams.delete("client_secret");
    url.searchParams.delete("code_verifier");
    this.#pending.set(state, { verifier, expiresAt: now + (this.#config.stateTTLms ?? 300_000) });
    return url.href;
  }

  async #exclusive<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    if (this.#busy) throw new OAuthError("An OAuth session operation is already in progress");
    this.#busy = true;
    try {
      return await operation(this.#generation);
    } finally {
      this.#busy = false;
    }
  }

  async #post(endpoint: URL, values: Record<string, string>, expectsTokens: boolean): Promise<unknown> {
    const body = new URLSearchParams(values);
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
    const method = this.#config.tokenEndpointAuthMethod;
    if (method === "client_secret_basic") {
      headers.set(
        "Authorization",
        `Basic ${btoa(`${formValue(this.#config.clientId)}:${formValue(this.#config.clientSecret!)}`)}`,
      );
    } else {
      body.set("client_id", this.#config.clientId);
      if (method === "client_secret_post") body.set("client_secret", this.#config.clientSecret!);
    }
    const timeout = AbortSignal.timeout(this.#config.timeoutMs ?? 30_000);
    const signal = this.#config.signal ? AbortSignal.any([timeout, this.#config.signal]) : timeout;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: body.toString(),
        headers,
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400)
        throw new OAuthError("OAuth endpoint redirects are refused", response.status);
      if (!response.ok) throw new OAuthError(`OAuth endpoint request failed (${response.status})`, response.status);
      if (!expectsTokens) return undefined;
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new OAuthError("OAuth endpoint returned invalid JSON");
      }
      if (!value || typeof value !== "object" || "error" in value)
        throw new OAuthError("OAuth endpoint reported an error");
      return value;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(signal.aborted ? "OAuth request was aborted or timed out" : "OAuth network request failed");
    }
  }

  #store(value: unknown, generation: number, previousRefresh?: string): OAuthSession {
    if (generation !== this.#generation) throw new OAuthError("OAuth session was cleared during the request");
    const result = value as Record<string, unknown>;
    const accessToken = result.access_token;
    const tokenType = result.token_type;
    const refreshToken = result.refresh_token;
    const expiresIn = result.expires_in;
    if (
      typeof accessToken !== "string" ||
      !/^[\x21-\x7e]+$/.test(accessToken) ||
      typeof tokenType !== "string" ||
      !/^[A-Za-z][A-Za-z0-9._-]*$/.test(tokenType)
    )
      throw new OAuthError("OAuth endpoint returned invalid token data");
    if (refreshToken !== undefined && (typeof refreshToken !== "string" || !/^[\x21-\x7e]+$/.test(refreshToken)))
      throw new OAuthError("OAuth endpoint returned invalid refresh token data");
    if (
      expiresIn !== undefined &&
      (typeof expiresIn !== "number" ||
        !Number.isSafeInteger(expiresIn) ||
        expiresIn < 0 ||
        !Number.isSafeInteger(Date.now() + expiresIn * 1000))
    )
      throw new OAuthError("OAuth endpoint returned invalid token expiration");
    this.#tokens = {
      accessToken,
      tokenType,
      refreshToken: (refreshToken as string | undefined) ?? previousRefresh,
      expiresAt: expiresIn === undefined ? undefined : Date.now() + (expiresIn as number) * 1000,
    };
    return this.session;
  }

  async exchangeCallback(callbackURL: string): Promise<OAuthSession> {
    return this.#exclusive(async generation => {
      const callback = checkedURL(callbackURL);
      if (callback.origin !== this.#redirect.origin || callback.pathname !== this.#redirect.pathname)
        throw new OAuthError("OAuth callback does not match the configured redirect URI");
      const responseParameters = new Set(["code", "state", "error", "error_description", "error_uri", "iss"]);
      for (const key of callback.searchParams.keys()) {
        if (!responseParameters.has(key) && !this.#redirect.searchParams.has(key))
          throw new OAuthError("OAuth callback contains an unconfigured query parameter");
      }
      for (const key of new Set(this.#redirect.searchParams.keys())) {
        const actual = callback.searchParams.getAll(key);
        const expected = this.#redirect.searchParams.getAll(key);
        if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
          throw new OAuthError("OAuth callback does not match the configured redirect URI");
      }
      if (callback.searchParams.getAll("state").length !== 1)
        throw new OAuthError("OAuth callback requires one state parameter");
      const state = callback.searchParams.get("state")!;
      const pending = this.#pending.get(state);
      if (!pending) throw new OAuthError("OAuth state is unknown or already used");
      this.#pending.delete(state);
      if (pending.expiresAt <= Date.now()) throw new OAuthError("OAuth state has expired");
      if (callback.searchParams.has("error")) throw new OAuthError("OAuth authorization was denied");
      if (callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code"))
        throw new OAuthError("OAuth callback requires one authorization code");
      const value = await this.#post(
        this.#tokenEndpoint,
        {
          grant_type: "authorization_code",
          code: callback.searchParams.get("code")!,
          redirect_uri: this.#config.redirectURI,
          code_verifier: pending.verifier,
        },
        true,
      );
      return this.#store(value, generation);
    });
  }

  async refresh(): Promise<OAuthSession> {
    return this.#exclusive(async generation => {
      const refreshToken = this.#tokens?.refreshToken;
      if (!refreshToken) throw new OAuthError("OAuth session has no refresh token");
      const result = await this.#post(
        this.#tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: refreshToken },
        true,
      );
      return this.#store(result, generation, refreshToken);
    });
  }

  async revoke(): Promise<void> {
    return this.#exclusive(async () => {
      if (!this.#revocation) throw new OAuthError("An owner-configured OAuth revocation endpoint is required");
      const tokens = this.#tokens;
      try {
        if (tokens?.refreshToken)
          await this.#post(this.#revocation, { token: tokens.refreshToken, token_type_hint: "refresh_token" }, false);
        if (tokens?.accessToken)
          await this.#post(this.#revocation, { token: tokens.accessToken, token_type_hint: "access_token" }, false);
      } finally {
        this.clear();
      }
    });
  }

  async withAccessToken<T>(use: (accessToken: string, tokenType: string) => T | Promise<T>): Promise<T> {
    if (!this.session.authenticated || !this.#tokens) throw new OAuthError("OAuth session has no usable access token");
    return use(this.#tokens.accessToken, this.#tokens.tokenType);
  }
}

export function createOAuthClient(config: OAuthClientConfig): OAuthClient {
  return new OAuthClient(config);
}
