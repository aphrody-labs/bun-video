#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { connect, type ChromiumConnection } from "bun:chromium";
import { detectActiveChromeProfile, planChromeSiteApp, type ActiveChromeProfile } from "./crunchyroll-app";
import { mkdir } from "node:fs";
import { join } from "node:path";

type RecordJSON = Record<string, any>;
export interface CookieExport {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    partitionKey?: RecordJSON;
  }[];
}
export interface CapturedRequest {
  sessionId: string;
  requestId: string;
  frameId?: string;
  request: RecordJSON;
  response?: RecordJSON;
  initiator?: RecordJSON;
  bodyFile?: string;
  bodyError?: string;
  finished?: boolean;
}

function Panel() {
  return (
    <section aria-label="Inspection réseau vidéo">
      <style>{`:host{all:initial}section{font:14px Segoe UI,sans-serif;color:#edf3ff;background:#131b2b;padding:12px;border:1px solid #52709a;border-radius:12px;box-shadow:0 5px 25px #0008;width:min(580px,80vw)}header,form,nav{display:flex;gap:8px;align-items:center;margin-bottom:8px}input{flex:1;min-width:0}button,input{font:inherit;padding:6px;border-radius:6px;border:1px solid #6083b3}button{cursor:pointer;background:#c7dcff;color:#15243a}input:user-invalid{outline:2px solid #ff7c80}details{margin-top:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}p{margin:6px 0}#flows{max-height:170px;overflow:auto}#flows button{display:block;width:100%;text-align:left;margin:3px 0;overflow-wrap:anywhere}`}</style>
      <header>
        <strong>Bun · Inspecteur vidéo</strong>
        <button id="collapse" type="button">
          Réduire
        </button>
      </header>
      <div id="body">
        <form>
          <label htmlFor="url">URL</label>
          <input id="url" type="url" required aria-describedby="status" />
          <button>Charger</button>
        </form>
        <nav>
          <button id="inspect" type="button">
            Sélectionner un élément
          </button>
          <button id="export" type="button">
            Exporter
          </button>
          <button id="quit" type="button">
            Fermer
          </button>
        </nav>
        <p id="status" role="status" aria-live="polite">
          Capture active · cliquer le lecteur pour identifier son cadre.
        </p>
        <label htmlFor="filter">Filtre réseau </label>
        <input id="filter" placeholder="m3u8, mpd, segment, domaine…" />
        <p id="selection">Tous les cadres · les correspondances sont des indices, pas une preuve de causalité.</p>
        <button id="all" type="button">
          Tous les cadres
        </button>
        <div id="flows" />
        <details>
          <summary>Détail de la requête / élément</summary>
          <pre id="detail" />
        </details>
        <details>
          <summary>Cookies JSON du site dans le profil actif</summary>
          <pre id="cookies" />
        </details>
      </div>
    </section>
  );
}

const panelHTML = renderToStaticMarkup(<Panel />);
// Installed in a CDP isolated world: the visited site cannot call the binding.
const panelScript = `(() => {
  function mount() {
    if (document.getElementById('__bun_inspector')) return;
    const host=document.createElement('div');host.id='__bun_inspector';
    host.style.cssText='position:fixed;right:12px;top:12px;z-index:2147483647';
    document.documentElement.append(host);
    const root=host.attachShadow({mode:'closed'});root.innerHTML=${JSON.stringify(panelHTML)};
    const q=id=>root.getElementById(id);
    q('url').value=location.href;
    const send=(action,value)=>globalThis.bunInspector(JSON.stringify({action,value}));
    root.querySelector('form').addEventListener('submit',e=>{e.preventDefault();if(e.isTrusted)send('navigate',q('url').value)});
    q('url').addEventListener('blur',()=>q('url').setAttribute('aria-invalid',String(q('url').matches(':user-invalid'))));
    for(const action of ['inspect','export','quit','all']) q(action).onclick=e=>{if(e.isTrusted)send(action)};
    q('collapse').onclick=()=>{q('body').hidden=!q('body').hidden};
    q('filter').oninput=()=>render();
    let state={flows:[]};
    function render(){
      q('flows').replaceChildren();
      const filter=q('filter').value.toLowerCase();
      for(const flow of state.flows.filter(x=>x.url.toLowerCase().includes(filter))){
        const b=document.createElement('button');b.type='button';b.textContent=flow.label+' '+flow.url;
        b.onclick=e=>{if(e.isTrusted)send('request',flow.key)};q('flows').append(b);
      }
    }
    globalThis.bunInspectorUpdate=(next)=>{
      Object.assign(state,next);render();
      for(const name of ['status','selection','detail','cookies']) if(next[name]!==undefined)q(name).textContent=next[name];
    };
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})()`;

function validURL(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("URL HTTP(S) sans identifiants requise.");
  return url.href;
}

export function mediaCandidate(request: CapturedRequest) {
  return (
    /Media/.test(request.response?.type ?? "") ||
    /(?:mpegurl|dash\+xml|video\/|audio\/)/i.test(request.response?.mimeType ?? "") ||
    /\.(?:m3u8|mpd|m4s|ts|mp4|webm|aac)(?:[?#]|$)/i.test(request.request.url)
  );
}

class Inspector {
  requests = new Map<string, CapturedRequest>();
  contexts = new Map<string, number>();
  targets = new Map<string, RecordJSON>();
  jobs = new Set<Promise<unknown>>();
  bodies = new Set<Promise<unknown>>();
  errors: string[] = [];
  selectedFrame?: string;
  selectedSession?: string;
  mainSession = "";
  mainTarget = "";
  eventCount = 0;
  exportJob?: Promise<RecordJSON>;
  sink: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  stop = Promise.withResolvers<void>();
  constructor(
    public cdp: ChromiumConnection,
    public directory: string,
  ) {
    this.sink = Bun.file(join(directory, "network.ndjson")).writer();
  }
  run(job: Promise<unknown>) {
    this.jobs.add(job);
    void job
      .catch(error => {
        this.errors.push(String(error));
        void this.update({ status: "Une opération a échoué ; voir les erreurs dans l'export." }).catch(error =>
          this.errors.push(String(error)),
        );
      })
      .finally(() => this.jobs.delete(job));
  }
  async update(state: RecordJSON) {
    const contextId = this.contexts.get(this.mainSession);
    if (!contextId) return;
    await this.cdp.send(
      "Runtime.evaluate",
      { contextId, expression: `globalThis.bunInspectorUpdate?.(${JSON.stringify(state)})` },
      this.mainSession,
    );
  }
  async flows() {
    const flows = [...this.requests.entries()]
      .filter(([, r]) => {
        const matchesFrame =
          !this.selectedFrame || r.frameId === this.selectedFrame || r.sessionId === this.selectedSession;
        return matchesFrame && mediaCandidate(r);
      })
      .slice(-150)
      .map(([key, r]) => ({
        key,
        url: r.request.url,
        label: `${r.response?.status ?? "…"} ${r.response?.mimeType ?? ""}`,
      }));
    await this.update({ flows });
  }
  async session(sessionId: string, target: RecordJSON) {
    this.targets.set(sessionId, target);
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send(
      "Network.enable",
      { maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 },
      sessionId,
    );
    await this.cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    if (["page", "iframe"].includes(target.type)) {
      await this.cdp.send("Page.enable", {}, sessionId);
      await this.cdp.send("DOM.enable", {}, sessionId);
      await this.cdp.send("Overlay.enable", {}, sessionId);
      await this.cdp.send(
        "Runtime.addBinding",
        { name: "bunInspector", executionContextName: "bun-inspector" },
        sessionId,
      );
      if (sessionId === this.mainSession)
        await this.cdp.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: panelScript, worldName: "bun-inspector" },
          sessionId,
        );
    }
    await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  }
  async select(sessionId: string, backendNodeId: number) {
    const { node } = await this.cdp.send<RecordJSON>("DOM.describeNode", { backendNodeId, depth: 0 }, sessionId);
    const { object } = await this.cdp.send<RecordJSON>("DOM.resolveNode", { backendNodeId }, sessionId);
    const { result } = await this.cdp.send<RecordJSON>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function(){return {tag:this.tagName,id:this.id,src:this.currentSrc||this.src||null,html:this.outerHTML?.slice(0,12000)}}`,
      },
      sessionId,
    );
    await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId);
    const { frameTree } = await this.cdp.send<RecordJSON>("Page.getFrameTree", {}, sessionId);
    this.selectedFrame = node.frameId ?? frameTree.frame.id;
    this.selectedSession = node.frameId ? undefined : sessionId;
    await this.cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }, sessionId);
    await this.update({
      selection: `Élément ${node.nodeName} · cadre ${this.selectedFrame}`,
      detail: JSON.stringify(result.value, null, 2),
    });
    await this.flows();
  }
  async action(payload: string) {
    const { action, value } = JSON.parse(payload);
    if (action === "navigate") await this.cdp.send("Page.navigate", { url: validURL(value) }, this.mainSession);
    else if (action === "inspect") {
      for (const [session, target] of this.targets)
        if (["page", "iframe"].includes(target.type))
          await this.cdp.send(
            "Overlay.setInspectMode",
            {
              mode: "searchForNode",
              highlightConfig: { showInfo: true, contentColor: { r: 65, g: 160, b: 255, a: 0.3 } },
            },
            session,
          );
    } else if (action === "all") {
      this.selectedFrame = undefined;
      this.selectedSession = undefined;
      await this.update({ selection: "Tous les cadres" });
      await this.flows();
    } else if (action === "request") await this.update({ detail: JSON.stringify(this.requests.get(value), null, 2) });
    else if (action === "export") await this.export();
    else if (action === "quit") {
      await this.export();
      this.stop.resolve();
    }
  }
  async body(sessionId: string, requestId: string) {
    const record = this.requests.get(`${sessionId}:${requestId}`);
    if (!record) return;
    try {
      const result = await this.cdp.send<{ body: string; base64Encoded: boolean }>(
        "Network.getResponseBody",
        { requestId },
        sessionId,
      );
      const extension = /javascript/.test(record.response?.mimeType ?? "")
        ? "js"
        : /css/.test(record.response?.mimeType ?? "")
          ? "css"
          : /html/.test(record.response?.mimeType ?? "")
            ? "html"
            : "body";
      const filename = `resources/${Bun.hash(`${sessionId}:${requestId}`).toString(16)}.${extension}`;
      await Bun.write(
        join(this.directory, filename),
        result.base64Encoded ? Buffer.from(result.body, "base64") : result.body,
      );
      record.bodyFile = filename;
    } catch (error) {
      record.bodyError = String(error);
    }
  }
  event(method: string, params: RecordJSON, sessionId: string) {
    this.sink.write(JSON.stringify({ method, params, sessionId, receivedAt: new Date().toISOString() }) + "\n");
    this.eventCount++;
    const key = `${sessionId}:${params.requestId}`;
    if (method === "Network.requestWillBeSent") {
      const prior = this.requests.get(key);
      if (prior && params.redirectResponse)
        this.requests.set(`${key}:redirect:${this.eventCount}`, {
          ...prior,
          response: params.redirectResponse,
          finished: true,
        });
      this.requests.set(key, {
        sessionId,
        requestId: params.requestId,
        frameId: params.frameId,
        request: params.request,
        initiator: params.initiator,
      });
    } else if (method === "Network.responseReceived") {
      const record = this.requests.get(key);
      if (record) record.response = { ...params.response, type: params.type };
      this.run(this.flows());
    } else if (method === "Network.loadingFinished") {
      const record = this.requests.get(key);
      if (record) record.finished = true;
      const job = this.body(sessionId, params.requestId);
      this.bodies.add(job);
      void job.finally(() => this.bodies.delete(job));
      this.run(job);
    } else if (method === "Network.loadingFailed") {
      const record = this.requests.get(key);
      if (record) {
        record.finished = true;
        record.bodyError = params.errorText;
      }
    }
  }
  export() {
    return (this.exportJob ??= this.writeExport().finally(() => {
      this.exportJob = undefined;
    }));
  }
  async writeExport() {
    await Promise.allSettled(this.bodies);
    await this.sink.flush();
    const { result: location } = await this.cdp.send<RecordJSON>(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      this.mainSession,
    );
    const urls = [
      ...new Set([location.value, ...[...this.requests.values()].map(request => request.request.url)]),
    ].filter(url => typeof url === "string" && /^https?:/.test(url));
    const cookies = await this.cdp.send<CookieExport>("Network.getCookies", { urls }, this.mainSession);
    await Bun.write(join(this.directory, "cookies.json"), JSON.stringify(cookies, null, 2));
    const { result } = await this.cdp.send<RecordJSON>(
      "Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true },
      this.mainSession,
    );
    await Bun.write(join(this.directory, "site.html"), result.value);
    const { data } = await this.cdp.send<{ data: string }>(
      "Page.captureSnapshot",
      { format: "mhtml" },
      this.mainSession,
    );
    await Bun.write(join(this.directory, "site.mhtml"), data);
    await this.networkJSON();
    await this.update({ status: `Export privé : ${this.directory}`, cookies: JSON.stringify(cookies, null, 2) });
    return cookies;
  }
  async networkJSON() {
    await this.sink.flush();
    const input = Bun.file(join(this.directory, "network.ndjson"));
    const snapshot = input.slice(0, input.size);
    const output = Bun.file(join(this.directory, "network.json")).writer();
    output.write('{"format":"cdp-network-v1","events":[');
    let carry = "",
      first = true;
    const decoder = new TextDecoder();
    for await (const chunk of snapshot.stream()) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop()!;
      for (const line of lines)
        if (line) {
          output.write((first ? "" : ",") + line);
          first = false;
        }
    }
    output.write(
      '],"requests":' + JSON.stringify([...this.requests.values()]) + ',"errors":' + JSON.stringify(this.errors) + "}",
    );
    await output.end();
  }
}

async function existingChromeProfile(): Promise<ActiveChromeProfile> {
  try {
    return await detectActiveChromeProfile();
  } catch (activeError) {
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }).Count",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => child.kill(), 10000);
    let count: string;
    let code: number;
    try {
      [count, code] = await Promise.all([child.stdout.text(), child.exited]);
    } finally {
      clearTimeout(timer);
    }
    if (code !== 0 || count.trim() !== "0") throw activeError;
    if (!Bun.env.LOCALAPPDATA) throw new Error("Répertoire des profils Chrome existants indisponible.");
    const userDataDir = join(Bun.env.LOCALAPPDATA, "Google", "Chrome", "User Data");
    if (!(await Bun.file(join(userDataDir, "Local State")).exists()))
      throw new Error("Aucun profil Chrome original existant.");
    const state = await Bun.file(join(userDataDir, "Local State")).json();
    const profileDirectory = state?.profile?.last_used;
    if (typeof profileDirectory !== "string" || !state?.profile?.info_cache?.[profileDirectory])
      throw new Error("Dernier profil Chrome existant non identifié.");
    if (!(await Bun.file(join(userDataDir, profileDirectory, "Preferences")).exists()))
      throw new Error("Le profil Chrome original indiqué n'existe pas.");
    const executableCandidates = [Bun.env.PROGRAMFILES, Bun.env["PROGRAMFILES(X86)"], Bun.env.LOCALAPPDATA]
      .filter((root): root is string => !!root)
      .map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"));
    for (const executable of executableCandidates)
      if (await Bun.file(executable).exists()) return { pid: 0, executable, userDataDir, profileDirectory };
    throw new Error("Exécutable Google Chrome propriétaire introuvable.");
  }
}

async function activeEndpoint(profile: ActiveChromeProfile, explicit?: string): Promise<string> {
  if (!profile.pid)
    throw new Error(
      "CDP absent : Chrome était fermé ; fenêtre réelle du profil original ouverte, inspection/export indisponibles.",
    );
  let endpoint = explicit;
  if (!endpoint) {
    const activePort = Bun.file(join(profile.userDataDir, "DevToolsActivePort"));
    if (!(await activePort.exists()))
      throw new Error("CDP absent du profil Chrome actif ; fenêtre réelle ouverte, inspection/export indisponibles.");
    const [port, browserPath] = (await activePort.text()).trim().split(/\r?\n/);
    if (!/^\d+$/.test(port ?? "") || !browserPath?.startsWith("/devtools/browser/"))
      throw new Error("DevToolsActivePort invalide ; aucune configuration Chrome modifiée.");
    endpoint = `ws://127.0.0.1:${port}${browserPath}`;
  }
  const parsed = new URL(endpoint);
  if (
    !["http:", "ws:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    !parsed.port
  )
    throw new Error("Endpoint CDP local explicite requis.");
  const owner = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$listeners=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:BUN_INSPECT_PORT) -ErrorAction SilentlyContinue); if ($listeners | Where-Object { $_.OwningProcess -eq ([int]$env:BUN_INSPECT_PID) }) { 'OWNED' } else { exit 1 }",
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, BUN_INSPECT_PORT: parsed.port, BUN_INSPECT_PID: String(profile.pid) },
    },
  );
  const timeout = setTimeout(() => owner.kill(), 10000);
  try {
    const [proof, code] = await Promise.all([owner.stdout.text(), owner.exited]);
    if (code !== 0 || proof.trim() !== "OWNED")
      throw new Error("Endpoint CDP non attribuable au processus Chrome du profil actif.");
  } finally {
    clearTimeout(timeout);
  }
  const response = await fetch(`http://${parsed.host}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Endpoint CDP du profil actif inaccessible.");
  const version = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("Endpoint CDP navigateur absent.");
  return version.webSocketDebuggerUrl;
}

export async function runNetworkWindow(url: string, options: { check?: boolean; endpoint?: string } = {}) {
  return networkWindowMain([
    url,
    ...(options.check ? ["--check"] : []),
    ...(options.endpoint ? ["--endpoint", options.endpoint] : []),
  ]);
}

export async function networkWindowMain(args = Bun.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "network-window.exe [URL] [--check] [--endpoint URL-CDP-local]\nProfil Chrome original actif ou dernier utilisé ; URL par défaut https://www.crunchyroll.com/. Aucun profil copié ni redémarrage Chrome.",
    );
    return;
  }
  if (process.platform !== "win32") throw new Error("Cette application nécessite Windows natif.");
  const endpointIndex = args.indexOf("--endpoint");
  if (endpointIndex >= 0 && !args[endpointIndex + 1]) throw new Error("--endpoint nécessite une URL locale.");
  for (const arg of args)
    if (arg.startsWith("--") && !["--check", "--endpoint"].includes(arg)) throw new Error(`Option inconnue : ${arg}`);
  const url = validURL(
    args.find((arg, index) => !arg.startsWith("--") && !(endpointIndex >= 0 && index === endpointIndex + 1)) ??
      "https://www.crunchyroll.com/",
  );
  const profile = await existingChromeProfile();
  let cdp: ChromiumConnection | undefined;
  let inspector: Inspector | undefined;
  let target: RecordJSON | undefined;
  let opened = false;
  const open = async () => {
    const command = planChromeSiteApp(profile).command.map(argument =>
      argument.startsWith("--app=") ? `--app=${url}` : argument,
    );
    const child = Bun.spawn(command, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    opened = true;
  };
  try {
    let endpoint: string;
    try {
      endpoint = await activeEndpoint(profile, endpointIndex >= 0 ? args[endpointIndex + 1] : undefined);
    } catch (error) {
      await open();
      throw error;
    }
    cdp = await connect(endpoint, { timeout: 15000 });
    const { targetInfos: before } = await cdp.send<{ targetInfos: RecordJSON[] }>("Target.getTargets");
    const prior = new Set(before.map(info => info.targetId));
    const created = Promise.withResolvers<RecordJSON>();
    const cancelCreated = cdp.on("Target.targetCreated", params => {
      const info = params.targetInfo as RecordJSON;
      if (info.type === "page" && !prior.has(info.targetId) && info.url === url) created.resolve(info);
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await open();
    const { targetInfos: after } = await cdp.send<{ targetInfos: RecordJSON[] }>("Target.getTargets");
    target = after.find(info => info.type === "page" && !prior.has(info.targetId) && info.url === url);
    let targetTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      target ??= await Promise.race([
        created.promise,
        new Promise<never>((_, reject) => {
          targetTimer = setTimeout(
            () => reject(new Error("Nouvelle fenêtre du site non identifiée ; aucun onglet existant attaché.")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(targetTimer);
      cancelCreated();
    }
    const home = Bun.env.APHRODY_HOME ?? join(Bun.env.USERPROFILE!, ".aphrody");
    const directory = join(
      home,
      "cookies",
      "network-window",
      `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID()}`,
    );
    await new Promise<void>((ok, fail) =>
      mkdir(join(directory, "resources"), { recursive: true }, error => (error ? fail(error) : ok())),
    );
    inspector = new Inspector(cdp, directory);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const app = inspector;
    app.mainSession = sessionId;
    app.mainTarget = target.targetId;
    cdp.on("Runtime.executionContextCreated", (p, s) => {
      const context = p.context as RecordJSON;
      if (context.name === "bun-inspector" && s) app.contexts.set(s, context.id);
    });
    cdp.on("Runtime.executionContextsCleared", (_p, s) => {
      if (s) app.contexts.delete(s);
    });
    cdp.on("Runtime.bindingCalled", (p, s) => {
      if (s === app.mainSession && p.executionContextId === app.contexts.get(s)) app.run(app.action(String(p.payload)));
    });
    cdp.on("Overlay.inspectNodeRequested", (p, s) => {
      if (s && app.targets.has(s)) app.run(app.select(s, Number(p.backendNodeId)));
    });
    cdp.on("Target.attachedToTarget", (p, parent) => {
      if (parent && app.targets.has(parent)) app.run(app.session(String(p.sessionId), p.targetInfo as RecordJSON));
    });
    cdp.on("Target.detachedFromTarget", p => {
      app.targets.delete(String(p.sessionId));
    });
    cdp.on("Target.targetDestroyed", p => {
      if (p.targetId === app.mainTarget) app.stop.resolve();
    });
    const protocolURL = new URL(endpoint);
    protocolURL.protocol = "http:";
    protocolURL.pathname = "/json/protocol";
    const protocolResponse = await fetch(protocolURL, { signal: AbortSignal.timeout(10000) });
    if (!protocolResponse.ok) throw new Error("Chrome n'a pas fourni son schéma CDP.");
    const protocol = (await protocolResponse.json()) as { domains: { domain: string; events?: { name: string }[] }[] };
    const events = protocol.domains.find(domain => domain.domain === "Network")?.events;
    if (!events) throw new Error("Schéma Network absent.");
    for (const event of events)
      cdp.on(`Network.${event.name}`, (p, s) => {
        if (s && app.targets.has(s)) app.event(`Network.${event.name}`, p, s);
      });
    await app.session(sessionId, target);
    const { frameTree } = await cdp.send<RecordJSON>("Page.getFrameTree", {}, sessionId);
    const { executionContextId } = await cdp.send<RecordJSON>(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "bun-inspector" },
      sessionId,
    );
    app.contexts.set(sessionId, executionContextId);
    await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: panelScript }, sessionId);
    console.log(`Fenêtre Chrome du profil actif ouverte. Exports privés : ${directory}`);
    if (args.includes("--check")) {
      const { root } = await cdp.send<RecordJSON>("DOM.getDocument", {}, sessionId);
      await app.select(sessionId, root.backendNodeId);
      await app.export();
      const { result } = await cdp.send<RecordJSON>(
        "Runtime.evaluate",
        {
          expression:
            "({url:location.href,title:document.title,readyState:document.readyState,videos:document.querySelectorAll('video').length})",
          returnByValue: true,
        },
        sessionId,
      );
      console.log(
        JSON.stringify({
          check: "real-site-inspected",
          site: result.value,
          requests: app.requests.size,
          output: directory,
          playbackQualified: false,
        }),
      );
    } else {
      await app.stop.promise;
      await cdp.send("Target.closeTarget", { targetId: app.mainTarget }).catch(() => {});
    }
  } catch (error) {
    if (!opened) await open();
    throw error;
  } finally {
    if (inspector) {
      await Promise.allSettled(inspector.bodies);
      await inspector.networkJSON();
      await inspector.sink.end();
    }
    cdp?.close();
  }
}

if (import.meta.main) await networkWindowMain();

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = networkWindowMain;
