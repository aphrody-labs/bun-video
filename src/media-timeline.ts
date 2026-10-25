import { lstat, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#101010"><title>Bun Video</title>
<style>
:root{color-scheme:dark;font-family:Inter,"SF Pro Display",system-ui,sans-serif;background:#101010;color:#f8f5f2;--bun:#f97843}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}#timeline{height:100dvh;overflow-y:auto;scroll-snap-type:y mandatory;overscroll-behavior-y:contain;scrollbar-width:none}#timeline::-webkit-scrollbar{display:none}.clip{position:relative;width:100%;height:100dvh;scroll-snap-align:start;scroll-snap-stop:always;background:#101010;overflow:hidden}.clip video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#080808}.shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,#0009,transparent 24%,transparent 70%,#000b)}.brand{position:absolute;top:env(safe-area-inset-top,16px);left:clamp(18px,4vw,56px);z-index:2;font-weight:740;letter-spacing:-.04em;font-size:18px}.brand i{font-style:normal;color:var(--bun)}.title{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 54px);left:clamp(18px,5vw,72px);right:clamp(18px,8vw,110px);font-size:clamp(20px,3.1vw,42px);font-weight:620;letter-spacing:-.035em;line-height:1.08;overflow-wrap:anywhere}.index{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);left:clamp(18px,5vw,72px);font-size:11px;letter-spacing:.18em;color:#f97843;text-transform:uppercase}.hint{position:absolute;right:clamp(18px,4vw,56px);bottom:calc(env(safe-area-inset-bottom,0px) + 28px);font-size:11px;color:#c7c2bd;letter-spacing:.08em}.empty{height:100dvh;display:grid;place-items:center;padding:28px;text-align:center;color:#c7c2bd}.empty strong{display:block;color:#fff;font-size:clamp(25px,5vw,54px);letter-spacing:-.045em;margin-bottom:12px}.empty code{color:var(--bun)}@media(prefers-reduced-motion:reduce){#timeline{scroll-behavior:auto}}
</style></head><body><main id="timeline" aria-label="Timeline vidéo"><section class="empty"><div><strong>Bun Video</strong>Chargement de vos vidéos…</div></section></main>
<script type="module">
const root=document.querySelector('#timeline');let active=-1;function esc(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function activate(index){if(index===active)return;active=index;document.querySelectorAll('.clip video').forEach((v,i)=>{if(i===index){if(!v.src)v.src=v.dataset.src;v.play().catch(()=>{})}else v.pause()})}
try{const response=await fetch('/api/videos',{cache:'no-store'});if(!response.ok)throw Error('timeline unavailable');const files=await response.json();if(!files.length){root.innerHTML='<section class="empty"><div><strong>Aucune vidéo</strong>Téléchargez ou copiez des vidéos dans le dossier média, puis rechargez la page.</div></section>'}else{root.innerHTML=files.map((file,i)=>'<section class="clip" data-index="'+i+'"><video muted playsinline loop preload="none" data-src="/media/'+encodeURIComponent(file)+'" aria-label="'+esc(file)+'"></video><div class="shade"></div><div class="brand">Bun<i>.</i>Video</div><div class="title">'+esc(file.replace(/\\.[^.]+$/,''))+'</div><div class="index">'+String(i+1).padStart(2,'0')+' / '+String(files.length).padStart(2,'0')+'</div><div class="hint">DÉFILE POUR CONTINUER ↓</div></section>').join('');const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting&&entry.intersectionRatio>.65)activate(Number(entry.target.dataset.index))}),{root,threshold:[.65]});document.querySelectorAll('.clip').forEach(section=>observer.observe(section));activate(0)}}catch{root.innerHTML='<section class="empty"><div><strong>Timeline indisponible</strong>Relancez le serveur média Bun Video.</div></section>'}
</script></body></html>`;

function parseRange(value: string | null, size: number): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return undefined;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    return undefined;
  end = Math.min(end, size - 1);
  return { start, end };
}

export function createMediaTimelineServer(rootDirectory: string, port = 8787) {
  const root = resolve(rootDirectory);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError("Port must be 0..65535");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      if (url.pathname === "/")
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      if (url.pathname === "/api/videos") {
        const entries = await readdir(root, { withFileTypes: true });
        const files = entries
          .filter(entry => entry.isFile() && VIDEO_TYPES[extname(entry.name).toLowerCase()])
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return Response.json(files, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (url.pathname.startsWith("/media/")) {
        let name: string;
        try {
          name = decodeURIComponent(url.pathname.slice("/media/".length));
        } catch {
          return new Response(null, { status: 400 });
        }
        if (!name || name !== name.split(/[\\/]/).at(-1)) return new Response(null, { status: 400 });
        const type = VIDEO_TYPES[extname(name).toLowerCase()];
        if (!type) return new Response(null, { status: 415 });
        const path = join(root, name);
        if (!(await lstat(path).catch(() => null))?.isFile()) return new Response(null, { status: 404 });
        const file = Bun.file(path);
        if (!(await file.exists())) return new Response(null, { status: 404 });
        const baseHeaders = {
          "content-type": type,
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=60",
        };
        const range = parseRange(request.headers.get("range"), file.size);
        if (request.headers.has("range") && !range)
          return new Response(null, {
            status: 416,
            headers: { ...baseHeaders, "content-range": `bytes */${file.size}` },
          });
        if (range) {
          const body = request.method === "HEAD" ? null : file.slice(range.start, range.end + 1);
          return new Response(body, {
            status: 206,
            headers: {
              ...baseHeaders,
              "content-length": String(range.end - range.start + 1),
              "content-range": `bytes ${range.start}-${range.end}/${file.size}`,
            },
          });
        }
        return new Response(request.method === "HEAD" ? null : file, {
          headers: { ...baseHeaders, "content-length": String(file.size) },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return server;
}
