/** Bun-owned static host for the existing Rust/WASM editor. No project data leaves the browser. */
import { resolve, sep } from "node:path";

const root = resolve(Bun.env.FILMCRAFT_DIST ?? "");
if (!Bun.env.FILMCRAFT_DIST || !(await Bun.file(`${root}/index.html`).exists())) {
  throw new Error("FILMCRAFT_DIST must name a qualified FilmCraft web distribution");
}
const port = Number(Bun.env.PORT ?? 8765);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be between 0 and 65535");
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png",
  svg: "image/svg+xml",
  css: "text/css; charset=utf-8",
  json: "application/json",
};
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({ service: "aphrody-video-editor", runtime: Bun.version }, { headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400, headers });
    }
    if (pathname.startsWith("/film/")) pathname = pathname.slice(5);
    if (pathname === "/") pathname = "/index.html";
    const path = resolve(root, `.${pathname}`);
    const extension = path.split(".").at(-1) ?? "";
    if (!path.startsWith(`${root}${sep}`) || !mime[extension] || pathname.includes("\0"))
      return new Response(null, { status: 404, headers });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response(null, { status: 404, headers });
    const cache = extension === "html" ? "no-cache" : "public, max-age=31536000, immutable";
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        ...headers,
        "Content-Type": mime[extension]!,
        "Content-Length": String(file.size),
        "Cache-Control": cache,
      },
    });
  },
});
console.log(JSON.stringify({ service: "aphrody-video-editor", port: server.port }));
