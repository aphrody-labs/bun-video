export interface BunCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: string;
  sameSite?: "strict" | "lax" | "none";
}

export interface ChromiumCookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  url?: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface CookieBundle {
  schemaVersion: 1;
  bun: BunCookie[];
  chromium: ChromiumCookie[];
}

export interface HlsConfig {
  src: string | null;
  config: { enableWorker: false };
  pageUrl?: string;
}

function invalid(): never {
  throw new Error("Invalid cookie export; cookie values are omitted from diagnostics.");
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}

function booleanField(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== "boolean") invalid();
  return input[key] as boolean;
}

function httpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Expected an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Expected an HTTP(S) URL without embedded credentials.");
  }
  return url;
}

export function normalizeCookieExport(input: unknown): CookieBundle {
  if (!Array.isArray(input)) invalid();
  const bundle: CookieBundle = { schemaVersion: 1, bun: [], chromium: [] };
  for (const item of input) {
    const raw = record(item);
    if (raw.partitionKey !== undefined || raw.partitioned === true) invalid();
    if (typeof raw.name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(raw.name)) invalid();
    if (typeof raw.value !== "string" || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(raw.value)) invalid();
    if (typeof raw.domain !== "string" || !raw.domain || !/^\.?[A-Za-z0-9.-]+$/.test(raw.domain)) invalid();
    const host = raw.domain.replace(/^\./, "").toLowerCase();
    if (host.includes("..") || host.endsWith(".") || host.startsWith(".")) invalid();
    if (
      host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) ||
      host.length > 253
    )
      invalid();
    if (
      typeof raw.path !== "string" ||
      !raw.path.startsWith("/") ||
      /[;?#]/.test(raw.path) ||
      [...raw.path].some(char => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)
    )
      invalid();
    const secure = booleanField(raw, "secure", false);
    const httpOnly = booleanField(raw, "httpOnly", false);
    const hostOnly = booleanField(raw, "hostOnly", !raw.domain.startsWith("."));
    const session = booleanField(raw, "session", raw.expirationDate === undefined);
    if (
      raw.expirationDate !== undefined &&
      (typeof raw.expirationDate !== "number" || !Number.isFinite(raw.expirationDate) || raw.expirationDate < 0)
    )
      invalid();
    let sameSite: BunCookie["sameSite"];
    if (raw.sameSite !== undefined && raw.sameSite !== null) {
      if (typeof raw.sameSite !== "string") invalid();
      switch (raw.sameSite.toLowerCase()) {
        case "strict":
          sameSite = "strict";
          break;
        case "lax":
          sameSite = "lax";
          break;
        case "none":
        case "no_restriction":
          sameSite = "none";
          break;
        case "unspecified":
          break;
        default:
          invalid();
      }
    }
    const bun: BunCookie = { name: raw.name, value: raw.value, path: raw.path, secure, httpOnly };
    const chromium: ChromiumCookie = {
      name: raw.name,
      value: raw.value,
      path: raw.path,
      secure,
      httpOnly,
    };
    if (hostOnly) chromium.url = `${secure ? "https" : "http"}://${host}${raw.path}`;
    else {
      bun.domain = `.${host}`;
      chromium.domain = `.${host}`;
    }
    if (sameSite) {
      bun.sameSite = sameSite;
      chromium.sameSite = ({ strict: "Strict", lax: "Lax", none: "None" } as const)[sameSite];
    }
    if (!session && typeof raw.expirationDate === "number") {
      const date = new Date(raw.expirationDate * 1000);
      if (!Number.isFinite(date.getTime())) invalid();
      bun.expires = date.toISOString();
      chromium.expires = raw.expirationDate;
    }
    bundle.bun.push(bun);
    bundle.chromium.push(chromium);
  }
  return bundle;
}

export function parseCookieBundle(input: unknown): CookieBundle {
  try {
    const raw = input as CookieBundle;
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.chromium) || !Array.isArray(raw.bun)) throw new Error();
    const normalized = normalizeCookieExport(
      raw.chromium.map(cookie => ({
        ...cookie,
        domain: cookie.domain ?? new URL(String(cookie.url)).hostname,
        hostOnly: !cookie.domain,
        expirationDate: cookie.expires,
        session: cookie.expires === undefined,
      })),
    );
    if (JSON.stringify(normalized.bun) !== JSON.stringify(raw.bun)) throw new Error();
    return normalized;
  } catch {
    throw new Error("Invalid or inconsistent Bun/Chromium cookie bundle.");
  }
}

export function cookieHeader(cookies: readonly ChromiumCookie[], url: URL, now = Date.now() / 1000): string {
  httpUrl(url.href);
  const host = url.hostname.toLowerCase();
  const matching = cookies.filter(cookie => {
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(cookie.value)
    )
      invalid();
    if (cookie.secure && url.protocol !== "https:") return false;
    if (cookie.expires !== undefined && cookie.expires <= now) return false;
    const domain = cookie.domain?.replace(/^\./, "").toLowerCase();
    if (domain) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(domain) && host !== domain) return false;
      if (host !== domain && !host.endsWith(`.${domain}`)) return false;
    } else if (!cookie.url || httpUrl(cookie.url).hostname.toLowerCase() !== host) return false;
    const path = cookie.path || "/";
    return (
      url.pathname === path ||
      (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"))
    );
  });
  matching.sort((a, b) => b.path.length - a.path.length);
  return matching.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

export function rewritePlaylist(text: string, base: URL, proxy: (url: string) => string): string {
  httpUrl(base.href);
  const rewrite = (value: string): string => {
    let resolved: URL;
    try {
      resolved = new URL(value, base);
    } catch {
      throw new Error("Invalid playlist resource URL.");
    }
    return proxy(httpUrl(resolved.href).href);
  };
  return text
    .split(/(\r?\n)/)
    .map(line => {
      if (!line.trim() || /^\r?\n$/.test(line)) return line;
      if (line.trimStart().startsWith("#")) {
        return line.replace(/\bURI="([^"]*)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
      }
      return rewrite(line.trim());
    })
    .join("");
}

export function redactUrl(input: string | URL): string {
  const url = httpUrl(String(input));
  url.search = "";
  url.hash = "";
  return url.href;
}

export function validateHlsConfig(input: unknown): HlsConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid HLS configuration.");
  const raw = input as Record<string, unknown>;
  if (raw.src !== null && typeof raw.src !== "string") throw new Error("HLS src must be a URL or null.");
  const result: HlsConfig = {
    src: raw.src === null ? null : httpUrl(raw.src as string).href,
    config: { enableWorker: false },
  };
  if (raw.config !== undefined) {
    if (typeof raw.config !== "object" || raw.config === null || Array.isArray(raw.config))
      throw new Error("Invalid HLS playback options.");
    const options = raw.config as Record<string, unknown>;
    if (
      Object.keys(options).some(key => key !== "enableWorker") ||
      (options.enableWorker !== undefined && options.enableWorker !== false)
    ) {
      throw new Error("HLS lab supports only enableWorker: false.");
    }
  }
  if (raw.pageUrl !== undefined) {
    if (typeof raw.pageUrl !== "string") throw new Error("Invalid HLS page URL.");
    result.pageUrl = httpUrl(raw.pageUrl).href;
  }
  return result;
}
