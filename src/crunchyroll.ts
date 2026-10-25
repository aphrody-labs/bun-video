// SPDX-License-Identifier: MIT
// API migration of crunchyroll.js 1.1.1, Copyright (c) 2022 Mssjim.
// Original MIT license reproduced in ../docs/crunchyroll-migration.md.
export interface BrowserPasswordProvider {
  withCredential(
    selector: { url: string; username?: string },
    consumer: (credential: Readonly<{ username: string; password: string }>) => void | Promise<void>,
  ): Promise<void>;
}

function parseCrunchyrollContentUrl(value: string | URL, kind: "watch" | "series") {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["www.crunchyroll.com", "crunchyroll.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new CrunchyrollError(`Invalid official Crunchyroll ${kind} URL`);
  const match = url.pathname.match(
    new RegExp(`^/(?:([a-z]{2}(?:-[A-Za-z]{2})?)/)?${kind}/([A-Z0-9]{9,32})(?:/([^/]+))?/?$`),
  );
  if (!match) throw new CrunchyrollError(`Invalid Crunchyroll ${kind} path`);
  return { url: url.href, locale: match[1] ?? null, contentId: match[2]!, slug: match[3] ?? null };
}

export function parseCrunchyrollWatchUrl(value: string | URL) {
  return parseCrunchyrollContentUrl(value, "watch");
}

export function parseCrunchyrollSeriesUrl(value: string | URL) {
  return parseCrunchyrollContentUrl(value, "series");
}

export interface CrunchyrollOptions {
  baseURL?: string;
  /** Caller-owned OAuth application authorization; no embedded application credentials. */
  basicAuthorization?: string;
  accessToken?: string;
  accountId?: string;
  locale?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CmsSession {
  bucket: string;
  signature: string;
  policy: string;
  expires: string | number;
  key_pair_id: string;
}

export interface LoginResult {
  success: boolean;
  message: string;
  client: { id?: string; locale: string; time: number; authenticated: boolean };
}

export class CrunchyrollError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CrunchyrollError";
  }
}

/** Native fetch implementation of every public crunchyroll.js 1.1.1 operation. */
export class CrunchyrollClient {
  async loginWithBrowserPassword(provider: BrowserPasswordProvider, username?: string): Promise<LoginResult> {
    let result: LoginResult | undefined;
    if (!provider || typeof provider.withCredential !== "function")
      throw new TypeError("An explicit private browser password provider is required");
    await provider.withCredential({ url: "https://www.crunchyroll.com", username }, async credential => {
      result = await this.login(credential.username, credential.password);
    });
    if (!result) throw new CrunchyrollError("Private password provider did not supply a credential");
    return result;
  }
  readonly #base: URL;
  readonly #options: CrunchyrollOptions;
  #token?: string;
  #id?: string;
  #locale: string;
  #time = 0;
  #cms?: CmsSession;
  #credentials?: { email: string; password: string };
  #refresh?: Promise<void>;

  constructor(options: CrunchyrollOptions = {}) {
    this.#options = { ...options };
    this.#base = new URL(options.baseURL ?? "https://beta-api.crunchyroll.com");
    if (this.#base.username || this.#base.password || !["https:", "http:"].includes(this.#base.protocol)) {
      throw new CrunchyrollError("Invalid API base URL");
    }
    if (this.#base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(this.#base.hostname)) {
      throw new CrunchyrollError("API authorization requires HTTPS");
    }
    if (!Number.isFinite(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) <= 0) {
      throw new CrunchyrollError("timeoutMs must be positive and finite");
    }
    this.#token = options.accessToken ? `Bearer ${options.accessToken}` : undefined;
    this.#id = options.accountId;
    this.#locale = options.locale ?? "en-US";
  }

  get client(): LoginResult["client"] {
    return {
      id: this.#id,
      locale: this.#locale,
      time: this.#time,
      authenticated: Boolean(this.#cms && this.#token),
    };
  }

  async #request(path: string, query?: URLSearchParams, body?: URLSearchParams, basic = false): Promise<any> {
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base.origin) throw new CrunchyrollError("API request must stay on the configured origin");
    if (query) url.search = query.toString();
    const authorization = basic ? this.#options.basicAuthorization : this.#token;
    if (!authorization)
      throw new CrunchyrollError(
        basic ? "Caller-owned OAuth application authorization is required" : "You must login first",
      );
    const headers = new Headers({
      Authorization: authorization,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    });
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const signal = this.#options.signal ? AbortSignal.any([timeout, this.#options.signal]) : timeout;
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body?.toString(),
      signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400)
      throw new CrunchyrollError("API redirects are refused to protect authorization", response.status);
    if (!response.ok) throw new CrunchyrollError(`API request failed (${response.status})`, response.status);
    let result: any;
    try {
      result = await response.json();
    } catch {
      throw new CrunchyrollError("API response is not JSON", response.status);
    }
    if (!result || typeof result !== "object" || result.error || result.__class__ === "error") {
      throw new CrunchyrollError("API reported an error", response.status);
    }
    return result;
  }

  async #authenticate(): Promise<void> {
    const result = await this.#request("/index/v2");
    const cms = result.cms;
    if (
      !cms ||
      !["bucket", "signature", "policy", "key_pair_id"].every(key => typeof cms[key] === "string") ||
      !["number", "string"].includes(typeof cms.expires)
    ) {
      throw new CrunchyrollError("API returned an invalid CMS session");
    }
    this.#cms = cms;
    this.#time = Date.now();
  }

  async #passwordLogin(email: string, password: string): Promise<void> {
    if (!email || !password) throw new CrunchyrollError("Email and password are required");
    const result = await this.#request(
      "/auth/v1/token",
      undefined,
      new URLSearchParams({
        username: email,
        password,
        grant_type: "password",
        scope: "offline_access",
      }),
      true,
    );
    if (
      typeof result.account_id !== "string" ||
      typeof result.access_token !== "string" ||
      typeof result.token_type !== "string"
    ) {
      throw new CrunchyrollError("API returned an invalid token");
    }
    this.#token = `${result.token_type} ${result.access_token}`;
    this.#id = result.account_id;
    await this.#authenticate();
  }

  async login(email: string, password: string, locale = this.#locale): Promise<LoginResult> {
    this.#locale = locale;
    this.#cms = undefined;
    this.#credentials = undefined;
    try {
      await this.#passwordLogin(email, password);
      this.#credentials = { email, password };
      return { success: true, message: "Login successful", client: this.client };
    } catch (error) {
      this.#token = undefined;
      this.#id = undefined;
      this.#cms = undefined;
      return {
        success: false,
        message: error instanceof CrunchyrollError ? error.message : "Authentication request failed",
        client: this.client,
      };
    }
  }

  async loginWithAccessToken(): Promise<LoginResult> {
    this.#cms = undefined;
    try {
      await this.#authenticate();
      return { success: true, message: "Login successful", client: this.client };
    } catch (error) {
      return {
        success: false,
        message: error instanceof CrunchyrollError ? error.message : "Authentication request failed",
        client: this.client,
      };
    }
  }

  async #ensureLogin(): Promise<void> {
    if (!this.#token || !this.#cms) throw new CrunchyrollError("You must login first");
    if (Date.now() - this.#time <= 240_000) return;
    this.#refresh ??= (
      this.#credentials
        ? this.#passwordLogin(this.#credentials.email, this.#credentials.password)
        : this.#authenticate()
    ).finally(() => {
      this.#refresh = undefined;
    });
    await this.#refresh;
  }

  #query(values: Record<string, string | number> = {}): URLSearchParams {
    const cms = this.#cms!;
    return new URLSearchParams(
      Object.entries({
        ...values,
        Signature: cms.signature,
        Policy: cms.policy,
        Expires: cms.expires,
        "Key-Pair-Id": cms.key_pair_id,
        locale: this.#locale,
      }).map(([key, value]) => [key, String(value)]),
    );
  }

  async #content(path: () => string, values?: Record<string, string | number>, signed = true): Promise<any> {
    await this.#ensureLogin();
    return this.#request(path(), signed ? this.#query(values) : undefined);
  }

  #cmsPath(): string {
    return `/cms/v2${this.#cms!.bucket.split("/").map(encodeURIComponent).join("/")}`;
  }

  getProfile(): Promise<any> {
    return this.#content(() => "/accounts/v1/me/profile", undefined, false);
  }
  getAnime(animeId: string): Promise<any> {
    return this.#content(() => `${this.#cmsPath()}/series/${encodeURIComponent(animeId)}`);
  }
  getSeasons(animeId: string): Promise<any> {
    return this.#content(() => `${this.#cmsPath()}/seasons`, { series_id: animeId });
  }
  getEpisodes(seasonId: string): Promise<any> {
    return this.#content(() => `${this.#cmsPath()}/episodes`, { season_id: seasonId });
  }
  getCategories(animeId: string): Promise<any> {
    return this.#content(() => "/content/v1/tenant_categories", { guid: animeId });
  }
  getRate(animeId: string): Promise<any> {
    return this.#content(
      () => {
        if (!this.#id) throw new CrunchyrollError("An accountId is required for ratings");
        return `/content-reviews/v2/user/${encodeURIComponent(this.#id)}/rating/series/${encodeURIComponent(animeId)}`;
      },
      undefined,
      false,
    );
  }
  getSimilar(animeId: string, items = 10): Promise<any> {
    return this.#content(() => "/content/v1/similar_to", { guid: animeId, n: items });
  }
  search(query: string): Promise<any> {
    return this.#content(() => "/content/v1/search", { q: query });
  }
  getAllAnimes(start = 0, items = 10, sortBy = "alphabetical"): Promise<any> {
    return this.#content(() => "/content/v1/browse", { sort_by: sortBy, start, n: items });
  }
  getNewsFeed(): Promise<any> {
    return this.#content(() => "/content/v1/news_feed");
  }
}

export function createCrunchyrollClient(options: CrunchyrollOptions = {}): CrunchyrollClient {
  return new CrunchyrollClient(options);
}

export const client = createCrunchyrollClient();
export const login = client.login.bind(client);
export const getProfile = client.getProfile.bind(client);
export const getAnime = client.getAnime.bind(client);
export const getSeasons = client.getSeasons.bind(client);
export const getEpisodes = client.getEpisodes.bind(client);
export const getCategories = client.getCategories.bind(client);
export const getRate = client.getRate.bind(client);
export const getSimilar = client.getSimilar.bind(client);
export const search = client.search.bind(client);
export const getAllAnimes = client.getAllAnimes.bind(client);
export const getNewsFeed = client.getNewsFeed.bind(client);
