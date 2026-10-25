import { loadJsonSecret, saveJsonSecret, type JsonSecretStore } from "./secrets";

export const COOKIE_SECRET = { service: "aphrody.bun-video", name: "crunchyroll-cookies" } as const;

export interface ExportedCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | null;
  expirationDate?: number;
  session?: boolean;
}

/** Validates a Cookie-Editor JSON export and keeps only the fields Bun.WebView and aphrody-web need. */
export function parseCookieExport(text: string): ExportedCookie[] {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new TypeError("cookie export must be a JSON array");
  return list.map((cookie: ExportedCookie) => {
    if (typeof cookie?.name !== "string" || typeof cookie?.value !== "string" || typeof cookie?.domain !== "string")
      throw new TypeError("cookie entry is missing name, value or domain");
    return {
      domain: cookie.domain,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path ?? "/",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite ?? null,
      ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
      session: !!cookie.session,
    };
  });
}

/** Stores the exported cookies in the OS credential store, not in the repository. */
export async function storeCrunchyrollCookies(text: string, store?: JsonSecretStore) {
  const cookies = parseCookieExport(text);
  const meta = await saveJsonSecret({ ...COOKIE_SECRET }, cookies, store);
  return { count: cookies.length, ...meta };
}

export async function loadCrunchyrollCookies(store?: JsonSecretStore): Promise<ExportedCookie[] | null> {
  const value = await loadJsonSecret({ ...COOKIE_SECRET }, store);
  return value === null ? null : (value as ExportedCookie[]);
}

/** Injects stored cookies into a Bun.WebView through CDP Network.setCookie. */
export async function injectIntoView(
  view: { cdp(method: string, params?: object): Promise<unknown> },
  cookies: ExportedCookie[],
) {
  for (const cookie of cookies) {
    await view.cdp("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      ...(cookie.sameSite === "lax"
        ? { sameSite: "Lax" }
        : cookie.sameSite === "strict"
          ? { sameSite: "Strict" }
          : cookie.sameSite === "no_restriction"
            ? { sameSite: "None" }
            : {}),
      ...(cookie.expirationDate ? { expires: cookie.expirationDate } : {}),
    });
  }
  return cookies.length;
}
