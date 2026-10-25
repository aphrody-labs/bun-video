#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { createEpisodeServer } from "./server";
import type { EpisodeManifest } from "./manifest";
import { compareRGBAFrames } from "../../pixel-verify";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

async function check() {
  const checkOnly = Bun.argv.includes("--check-only");
  const args = Bun.argv.slice(2).filter(value => value !== "--check-only");
  const episodeDir = resolve(args[0] ?? resolve(import.meta.dir, "../../../.local/episodes/beerus-01"));
  const chrome = args[1] ?? resolve(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe");
  if (!(await Bun.file(chrome).exists())) throw new Error(`Chrome introuvable : ${chrome}`);
  const output = resolve(episodeDir, "browser-test");
  const manifest: EpisodeManifest = await Bun.file(resolve(episodeDir, "manifest.json")).json();
  const tokenSource = Bun.resolveSync("@aphrody/m3-tokens/dynamic-color", import.meta.dir);
  const tokensVersion = (await Bun.file(tokenSource.replace(/src[\\/]dynamic-color\.ts$/, "package.json")).json())
    .version;
  const profile = resolve(output, `profile-${crypto.randomUUID()}`);
  await mkdir(profile, { recursive: true });
  const server = await createEpisodeServer({ episodeDir, port: 0, chromiumExecutable: chrome });
  const chromeProcess = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe", windowsHide: true },
  );
  let socket: WebSocket | undefined;
  let browserClosed = false;
  const browserErrors: string[] = [];
  const pending = new Map<number, Pending>();
  let id = 0;
  let chromeDiagnostics = "";
  const deadline = setTimeout(() => chromeProcess.kill(), 60_000);
  try {
    const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome ne publie pas son endpoint CDP")), 15_000);
      void (async () => {
        const reader = chromeProcess.stderr.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          while (true) {
            const value = await reader.read();
            if (value.done) throw new Error("Chrome fermé avant l’ouverture CDP");
            text += decoder.decode(value.value, { stream: true });
            chromeDiagnostics = text.slice(-8000);
            const match = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
            if (match) {
              clearTimeout(timer);
              resolveEndpoint(match[1]!);
              return;
            }
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        } finally {
          reader.releaseLock();
        }
      })();
    });
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("Connexion CDP expirée")), 10_000);
      socket!.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket!.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Connexion CDP impossible ; Chrome exit=${chromeProcess.exitCode} ; ${chromeDiagnostics}`));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown")
        browserErrors.push(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            "Erreur navigateur",
        );
      const command = pending.get(message.id);
      if (!command) return;
      clearTimeout(command.timer);
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });
    function send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      const next = ++id;
      return new Promise<T>((resolveCommand, reject) => {
        const timer = setTimeout(() => {
          pending.delete(next);
          reject(new Error(`CDP expiré : ${method}`));
        }, 15_000);
        pending.set(next, { resolve: value => resolveCommand(value as T), reject, timer });
        socket!.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await send<{
        result: { value: T };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).catch(error => {
        throw new Error(
          `Évaluation navigateur échouée (${expression.slice(0, 140)}) : ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await send("Page.navigate", { url: server.url.href }, sessionId);
    await send("Runtime.enable", {}, sessionId);
    try {
      await evaluate(
        `new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Page React non chargée')),12000);const check=()=>{if(document.querySelector('video')){observer.disconnect();clearTimeout(timeout);resolve(true)}};const observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,childList:true});check()})`,
      );
    } catch (error) {
      throw new AggregateError([error, ...browserErrors], "Page React non chargée");
    }
    const metadata = await evaluate<{ width: number; height: number; duration: number; tracks: number }>(
      `(async()=>{const v=document.querySelector('video');if(!v.readyState)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Métadonnées vidéo non chargées')),12000);v.addEventListener('loadedmetadata',()=>{clearTimeout(timeout);resolve()},{once:true});v.addEventListener('error',()=>reject(new Error('Décodage vidéo impossible')),{once:true})});return {title:document.querySelector('h1').textContent,width:v.videoWidth,height:v.videoHeight,duration:v.duration,tracks:v.textTracks.length}})()`,
    );
    if (
      metadata.width !== manifest.width ||
      metadata.height !== manifest.height ||
      Math.abs(metadata.duration - manifest.durationSeconds) > 0.01
    )
      throw new Error("Les métadonnées du lecteur diffèrent de la source");
    if (metadata.tracks !== (manifest.subtitles ?? []).filter(track => track.file.endsWith(".vtt")).length)
      throw new Error("Les pistes WebVTT du lecteur ne correspondent pas au manifeste");
    const playback = await evaluate(
      `(async()=>{const v=document.querySelector('video');v.muted=true;await v.play();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Lecture vidéo immobile')),8000);const next=()=>{if(v.currentTime>0.1){clearTimeout(timeout);v.removeEventListener('timeupdate',next);resolve()}};v.addEventListener('timeupdate',next);next()});v.pause();document.querySelectorAll('.chapter')[2]?.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {time:v.currentTime,paused:v.paused}})()`,
    );
    const frame = await evaluate<{ index: number; width: number; height: number; missing: boolean }>(
      `(async()=>{document.querySelector('.chapter').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));document.querySelector('.frame-input button:last-child').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const img=document.querySelector('.frame-view>img');if(img)await img.decode();return {index:Number(document.querySelector('#frame-index').value),width:img?.naturalWidth??0,height:img?.naturalHeight??0,missing:!!document.querySelector('.frame-empty')}})()`,
    );
    if (frame.index !== 2) throw new Error("Le bouton image suivante ne sélectionne pas l’image 2");
    if ((manifest.frames?.count ?? 0) >= 2 && (frame.width !== manifest.width || frame.height !== manifest.height))
      throw new Error("L’image extraite ne charge pas à sa résolution originale");
    await evaluate(
      `(async()=>{const imgs=[...document.querySelectorAll('.storyboard img')];for(const img of imgs)img.loading='eager';await Promise.all(imgs.map(img=>img.decode()));const v=document.querySelector('video');const seeked=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Seek storyboard expiré')),8000);v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve()},{once:true})});document.querySelector('.storyboard button[aria-label="Aller à 13:00"]')?.click();await seeked})()`,
    );
    const themes: {
      time: number;
      seed: string;
      primary: string;
      surface: string;
      source: string;
      computation: string;
      adapter: unknown;
      samples: number;
    }[] = [];
    for (const time of [480, 780]) {
      const theme = await evaluate<(typeof themes)[number]>(
        `(async()=>{const v=document.querySelector('video');await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Seek de thème expiré')),8000);v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve()},{once:true});v.currentTime=${time}});const root=document.documentElement;await new Promise((resolve,reject)=>{const deadline=performance.now()+12000;function next(){if(root.dataset.frameAnalysisComputation==='WGSL'&&Math.abs(Number(root.dataset.frameAnalysisTime)-${time})<.1)return resolve();if(performance.now()>deadline)return reject(new Error('Thème GPU actuel non qualifié : '+document.querySelectorAll('.theme-source')[1]?.textContent));requestAnimationFrame(next)}next()});const s=getComputedStyle(root);return {time:v.currentTime,seed:root.dataset.frameThemeSeed,source:root.dataset.frameThemeSource,primary:s.getPropertyValue('--md-sys-color-primary').trim(),surface:s.getPropertyValue('--md-sys-color-surface').trim(),computation:root.dataset.frameAnalysisComputation,adapter:JSON.parse(root.dataset.frameAnalysisAdapter),samples:Number(root.dataset.frameAnalysisSamples)}})()`,
      );
      if (theme.source !== "video" || !theme.seed || !theme.primary || !theme.surface)
        throw new Error("Le thème ne provient pas d’une frame vidéo décodée");
      themes.push(theme);
      const capture = await send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
      await Bun.write(resolve(output, `theme-${time}.png`), Buffer.from(capture.data, "base64"));
    }
    if (
      themes[0]!.seed === themes[1]!.seed ||
      themes[0]!.primary === themes[1]!.primary ||
      themes[0]!.surface === themes[1]!.surface
    )
      throw new Error("Les deux scènes ne produisent pas des couleurs M3 distinctes");
    const streamingTheme = await evaluate<{ start: number; sampledTime: number; source: string }>(
      `(async()=>{const v=document.querySelector('video'),root=document.documentElement,start=v.currentTime;v.muted=true;await v.play();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Thème non actualisé pendant la lecture')),8000);const next=()=>{if(Number(root.dataset.frameThemeTime)-start>=1){clearTimeout(timeout);v.removeEventListener('timeupdate',next);resolve()}};v.addEventListener('timeupdate',next);next()});v.pause();return{start,sampledTime:Number(root.dataset.frameThemeTime),source:root.dataset.frameThemeSource}})()`,
    );
    const exactFile = resolve(episodeDir, "icons/exact/manifest.json");
    let exactSVG: { entries: Record<string, unknown>[] } | undefined;
    if (manifest.pixelSVG?.entries.length && (await Bun.file(exactFile).exists())) {
      exactSVG = await Bun.file(exactFile).json();
      for (const entry of exactSVG!.entries) {
        const rendered = await evaluate<{ reference: number[]; candidate: number[] }>(
          `(async()=>{const draw=async(path)=>{const img=new Image();img.src='/media/'+path;await img.decode();const canvas=document.createElement('canvas');canvas.width=${entry.width};canvas.height=${entry.height};const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(img,0,0);return Array.from(c.getImageData(0,0,canvas.width,canvas.height).data)};return{reference:await draw(${JSON.stringify(entry.referencePNG)}),candidate:await draw(${JSON.stringify(entry.svg)})}})()`,
        );
        const comparison = compareRGBAFrames(new Uint8Array(rendered.reference), new Uint8Array(rendered.candidate), {
          width: entry.width as number,
          height: entry.height as number,
        });
        if (!comparison.exact) throw new Error(`SVG ${entry.id} : ${comparison.differingPixels} pixels différents`);
        entry.verification = {
          ...comparison,
          status: "verified-browser-rgba",
          renderer: "native Google Chrome canvas",
          checkedAt: new Date().toISOString(),
        };
      }
      if (!checkOnly) await Bun.write(exactFile, JSON.stringify(exactSVG, null, 2));
    }
    const themeEntries = [];
    const themeRoot = resolve(episodeDir, "themes");
    await mkdir(themeRoot, { recursive: true });
    for (const highlight of manifest.highlights ?? []) {
      const time = highlight.start + highlight.duration / 2;
      const snapshot = await evaluate<{ seed: string; time: number; source: string; roles: Record<string, string> }>(
        `(async()=>{const v=document.querySelector('video');await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Seek snapshot M3 expiré')),8000);v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve()},{once:true});v.currentTime=${time}});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const root=document.documentElement,style=root.style,roles={};for(let i=0;i<style.length;i++){const key=style.item(i);if(key.startsWith('--md-sys-color-'))roles[key]=style.getPropertyValue(key)}return{seed:root.dataset.frameThemeSeed,time:Number(root.dataset.frameThemeTime),source:root.dataset.frameThemeSource,roles}})()`,
      );
      if (snapshot.source !== "video" || Object.keys(snapshot.roles).length < 40)
        throw new Error("Snapshot M3 sans frame ou rôles complets");
      const json = `themes/${highlight.id}.json`,
        css = `themes/${highlight.id}.colors.css`;
      const entry = {
        id: highlight.id,
        title: highlight.title,
        ...snapshot,
        requestedTimeSeconds: time,
        tokensVersion,
        sampling: {
          maxDimension: 64,
          owner: "bun-video applyVideoFrameTheme",
          tokensOwner: "@aphrody/m3-tokens/dynamic-color",
          variant: "content",
          dark: true,
        },
        json,
        css,
      };
      if (!checkOnly) {
        await Bun.write(resolve(episodeDir, json), JSON.stringify(entry, null, 2));
        await Bun.write(
          resolve(episodeDir, css),
          `:root{${Object.entries(snapshot.roles)
            .map(([key, value]) => `${key}:${value};`)
            .join("")}}\n`,
        );
      }
      themeEntries.push(entry);
    }
    if (!checkOnly) {
      await Bun.write(
        resolve(themeRoot, "m3-static-tokens.css"),
        Bun.file(Bun.resolveSync("@aphrody/m3-tokens/m3-tokens.css", import.meta.dir)),
      );
      await Bun.write(
        resolve(themeRoot, "README.md"),
        "# Thèmes des frames\n\nChaque JSON et feuille .colors.css provient de la frame vidéo réellement décodée au milieu du moment sélectionné. Les rôles de couleur sont générés par @aphrody/m3-tokens/dynamic-color, variante content sombre. m3-static-tokens.css contient les tokens propriétaires de forme, typographie, élévation, mouvement et états. Aucun code couleur de thème n’est inventé ou fixé dans l’interface.\n",
      );
      await Bun.write(
        resolve(themeRoot, "manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            owner: "@aphrody/m3-tokens",
            episodeId: manifest.id,
            entries: themeEntries,
            staticTokens: "themes/m3-static-tokens.css",
            readme: "themes/README.md",
            tokensVersion,
          },
          null,
          2,
        ),
      );
    }
    const components = await evaluate<{
      buttons: number;
      cards: number;
      sliders: number;
      tabs: number;
      progress: number;
      buttonBackground: string;
    }>(
      `(()=>{const count=name=>document.querySelectorAll('[data-m3-component="'+name+'"]').length;return{buttons:count('Button'),cards:count('Card'),sliders:count('Slider'),tabs:count('Tabs'),progress:count('ProgressBar'),buttonBackground:getComputedStyle(document.querySelector('.chapter.active')).backgroundColor}})()`,
    );
    if (
      !components.buttons ||
      !components.cards ||
      !components.sliders ||
      !components.tabs ||
      !components.progress ||
      components.buttonBackground === "rgba(0, 0, 0, 0)"
    )
      throw new Error("Les composants M3 ou leur CSS propriétaire ne sont pas chargés");
    const datasetPreviews = await evaluate<{ count: number; loaded: boolean }>(
      `(async()=>{const images=[...document.querySelectorAll('.dataset-previews img')];for(const image of images)image.loading='eager';await Promise.all(images.map(image=>image.decode()));return{count:images.length,loaded:images.every(image=>image.naturalWidth>0)}})()`,
    );
    if (!datasetPreviews.loaded || datasetPreviews.count !== Math.min(12, manifest.dataset?.previews?.length ?? 0))
      throw new Error("Les aperçus des frames retenues du dataset ne chargent pas");
    const layout = await send<{ cssContentSize: { width: number; height: number } }>(
      "Page.getLayoutMetrics",
      {},
      sessionId,
    );
    const desktop = await send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1440, height: layout.cssContentSize.height, scale: 1 },
      },
      sessionId,
    );
    await Bun.write(resolve(output, "desktop.png"), Buffer.from(desktop.data, "base64"));
    const moments = await evaluate(
      `(async()=>{document.querySelector('#tab-moments').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const imgs=[...document.querySelectorAll('.moments img')];await Promise.all(imgs.map(img=>img.decode()));return {count:imgs.length,loaded:imgs.every(img=>img.naturalWidth>0)}})()`,
    );
    const characters = await evaluate(
      `(async()=>{document.querySelector('#tab-characters').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const imgs=[...document.querySelectorAll('.characters img')];await Promise.all(imgs.map(img=>img.decode()));return {count:imgs.length,loaded:imgs.every(img=>img.naturalWidth>0)}})()`,
    );
    const delivery = await evaluate<{
      dataset?: { text: string; downloads: number; available: boolean; failed: string[] };
      package?: { text: string; downloads: number; available: boolean; failed: string[]; reconstructible: boolean };
    }>(
      `(async()=>{const result={},reconstructible=${JSON.stringify(manifest.package?.status?.startsWith("archives-reconstructible") ?? false)},volumes=${JSON.stringify(manifest.package?.volumes.map(item => `/media/${item.file}`) ?? [])};for(const name of ['dataset','package']){const section=document.querySelector('#'+name);if(!section)continue;const links=[...section.querySelectorAll('a[href^="/media/"]')];const responses=await Promise.all(links.slice(0,name==='package'?5:links.length).map(link=>fetch(link.href,{method:'HEAD'})));result[name]={text:section.innerText,downloads:links.length,available:responses.every(response=>response.ok),failed:responses.filter(response=>!response.ok).map(response=>response.status+' '+new URL(response.url).pathname),reconstructible:name==='package'&&reconstructible&&responses.every(response=>response.ok||(response.status===404&&volumes.includes(new URL(response.url).pathname)))}}return result})()`,
    );
    if (delivery.dataset && !delivery.dataset.available)
      throw new Error(`Un téléchargement du dataset est indisponible : ${delivery.dataset.failed.join(", ")}`);
    if (delivery.package && !delivery.package.available && !delivery.package.reconstructible)
      throw new Error("Un téléchargement du package est indisponible");
    if (manifest.dataset) {
      const dataset = await Bun.file(resolve(episodeDir, manifest.dataset.manifest)).json();
      if (dataset.captions?.japaneseAsrProof?.status === "complete") {
        if (!delivery.dataset?.text.includes(`${dataset.captions.japanese} segments`))
          throw new Error("Le compteur JA ASR affiché diffère du dataset déclaré");
        if (!delivery.dataset.text.includes("automatique non relue"))
          throw new Error("La transcription automatique doit afficher son statut non relu");
        if (
          dataset.captions.japaneseAsrProof.timestampGranularitySeconds &&
          !delivery.dataset.text.includes(
            `fenêtres de ${dataset.captions.japaneseAsrProof.timestampGranularitySeconds} s`,
          )
        )
          throw new Error("La granularité des timestamps ASR doit être visible");
      }
    }
    await evaluate(`document.querySelector('#tab-frames').click();window.scrollTo(0,0)`);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    const mobile = await evaluate<{ viewport: number; content: number; overflow: boolean }>(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({viewport:innerWidth,content:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth}))))`,
    );
    if (mobile.overflow) throw new Error("La page déborde horizontalement sur mobile");
    const screenshot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
    await Bun.write(resolve(output, "mobile.png"), Buffer.from(screenshot.data, "base64"));
    const report = {
      checkOnly,
      chrome,
      metadata,
      playback,
      frame,
      moments,
      characters,
      delivery,
      datasetPreviews,
      mobile,
      themes,
      streamingTheme,
      components,
      exactSVG: {
        count: exactSVG?.entries.length ?? 0,
        allVerified: exactSVG?.entries.every(entry => (entry.verification as { exact?: boolean })?.exact) ?? false,
      },
      themeSnapshots: themeEntries.length,
      screenshots: ["desktop.png", "mobile.png", "theme-480.png", "theme-780.png"],
    };
    await Bun.write(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await send("Browser.close");
    browserClosed = true;
  } finally {
    socket?.close();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("CDP fermé"));
    }
    if (!browserClosed) chromeProcess.kill();
    await chromeProcess.exited;
    clearTimeout(deadline);
    await server.stop(true);
    if (profile.startsWith(resolve(output) + sep) && basename(profile).startsWith("profile-"))
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
if (import.meta.main) {
  await check();
  if (Bun.env.BUN_VIDEO_BROWSER_DIAGNOSTICS === "1")
    console.error(JSON.stringify({ activeResources: process.getActiveResourcesInfo() }));
}
