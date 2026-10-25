import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { publicPackageFile } from "./package-file-policy";

export function runtimeBuiltinModule(specifier: string): boolean {
  if (isBuiltin(specifier) || specifier === "bun" || /^(?:bun|buv):/.test(specifier)) return true;
  try {
    // Hardcoded third-party modules retain their bare name; package files resolve to absolute paths.
    return Bun.resolveSync(specifier, import.meta.dir) === specifier;
  } catch {
    return false;
  }
}

function confined(path: string): boolean {
  return (
    path.startsWith("package/") &&
    path.length <= 2048 &&
    !path.includes("\\") &&
    path.split("/").every(part => part !== ".." && part !== "." && part !== "")
  );
}

function protectedPath(path: string): boolean {
  return !publicPackageFile(path);
}

function targets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targets);
  throw new TypeError("Package exports must contain explicit file targets");
}

export async function inspectPackageArchive(input: Uint8Array) {
  if (!input.byteLength || input.byteLength > 128 * 1024 * 1024)
    throw new Error("Package archive exceeds its input bound");
  const files = await new Bun.Archive(input).files();
  if (!files.size || files.size > 20_000) throw new Error("Package archive exceeds its entry bound");
  let bytes = 0;
  for (const [path, file] of files) {
    if (!confined(path) || protectedPath(path)) throw new Error(`Unsafe package entry: ${path}`);
    bytes += file.size;
    if (file.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024)
      throw new Error("Package archive exceeds its payload bound");
  }
  const packageJSON = files.get("package/package.json");
  if (!packageJSON || packageJSON.size > 1024 * 1024) throw new Error("Package manifest is absent or oversized");
  const manifest = JSON.parse(await packageJSON.text());
  if (manifest.name !== "@aphrody/bun-video" || manifest.private === true || typeof manifest.version !== "string")
    throw new Error("Expected a public versioned Bun Video package");
  const exports = Object.entries(manifest.exports as Record<string, unknown>);
  const bins = Object.entries(manifest.bin as Record<string, string>);
  for (const target of [...exports.flatMap(([, value]) => targets(value)), ...bins.map(([, path]) => path)]) {
    const name = "package/" + target.replace(/^\.\//, "");
    if (!target.startsWith("./") || !confined(name) || !files.has(name))
      throw new Error(`Package entrypoint is outside its payload: ${target}`);
  }
  for (const [, path] of bins) {
    if (!(await files.get("package/" + path.slice(2))!.text()).startsWith("#!/usr/bin/env bun"))
      throw new Error("Package CLI must select the Bun runtime explicitly");
  }
  const aliases: Record<string, string[]> = {};
  const tsconfig = files.get("package/tsconfig.json");
  if (tsconfig) {
    const config = Bun.JSONC.parse(await tsconfig.text()) as { compilerOptions?: { paths?: Record<string, string[]> } };
    Object.assign(aliases, config.compilerOptions?.paths);
    for (const values of Object.values(aliases)) {
      for (const path of values) {
        const name = "package/" + path.replace(/^\.\//, "");
        if (!path.startsWith("./") || !confined(name) || !files.has(name))
          throw new Error("A runtime mapping escapes the published package");
      }
    }
  }
  function runtimeTarget(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const conditions = value as Record<string, unknown>;
      return runtimeTarget(conditions.bun ?? conditions.import ?? conditions.default ?? conditions.require);
    }
  }
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts", tsconfig: { compilerOptions: { jsx: "react" } } }),
    tsx: new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }),
  };
  const missingImports = new Set<string>();
  const queue = [...exports.map(([, value]) => runtimeTarget(value)), ...bins.map(([, value]) => value)]
    .filter((target): target is string => !!target)
    .map(target => "package/" + target.slice(2));
  for (const worker of ["frame-worker.ts", "video-worker-entry.ts"]) {
    const path = "package/dist/src/" + worker;
    if (files.has(path)) queue.push(path);
  }
  const scanned = new Set<string>();
  while (queue.length) {
    const path = queue.pop()!;
    if (scanned.has(path)) continue;
    scanned.add(path);
    const file = files.get(path);
    if (!file || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) continue;
    const imports = transpilers[path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "ts"].scanImports(
      await file.text(),
    );
    for (const imported of imports) {
      if (!imported.path.startsWith(".")) {
        const specifier = imported.path;
        if (runtimeBuiltinModule(specifier)) continue;
        const alias = aliases[specifier]?.[0];
        if (alias) {
          queue.push("package/" + alias.slice(2));
          continue;
        }
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
        if (name === manifest.name) {
          const target = runtimeTarget(manifest.exports["." + specifier.slice(name.length)]);
          if (target) queue.push("package/" + target.slice(2));
          else missingImports.add(`${path} -> ${specifier}`);
        } else if (
          !manifest.dependencies?.[name] &&
          !manifest.optionalDependencies?.[name] &&
          !manifest.peerDependencies?.[name] &&
          !manifest.bunVideo?.runtimeExternal?.includes(specifier)
        ) {
          missingImports.add(`${path} -> undeclared ${specifier}`);
        }
        continue;
      }
      const stem = posix.normalize(posix.join(posix.dirname(path), imported.path));
      const sourceStem = stem.replace(/\.(?:mjs|cjs|js)$/, "");
      const candidates = [
        stem,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map(ext => sourceStem + ext),
        ...["index.ts", "index.tsx", "index.js"].map(name => posix.join(stem, name)),
      ];
      const found = candidates.find(name => files.has(name));
      if (!confined(stem) || !found) missingImports.add(`${path} -> ${imported.path}`);
      else queue.push(found);
    }
  }
  if (missingImports.size)
    throw new Error(
      `Package source import leaves its payload (${missingImports.size}): ${[...missingImports].slice(0, 24).join("; ")}`,
    );
  const qualificationPeers = manifest.bunVideo?.qualificationPeers ?? {};
  for (const [name, version] of Object.entries(qualificationPeers) as [string, string][]) {
    if (!manifest.peerDependencies?.[name] || !Bun.semver.satisfies(version, manifest.peerDependencies[name]))
      throw new Error("Qualification peer does not satisfy its public contract");
  }
  return {
    name: manifest.name as string,
    version: manifest.version as string,
    sha256: new Bun.CryptoHasher("sha256").update(input).digest("hex"),
    compressedBytes: input.byteLength,
    unpackedBytes: bytes,
    entries: files.size,
    runtimeFiles: scanned.size,
    exports: exports.map(([name]) => name),
    bins: bins.map(([name]) => name),
    optionalPeers: Object.keys(manifest.peerDependenciesMeta ?? {}).filter(
      name => manifest.peerDependenciesMeta[name].optional === true,
    ),
    qualificationPeers: qualificationPeers as Record<string, string>,
    // The probe imports the React export, so the consumer pins the React runtime that the archive itself declares.
    consumerReact: Object.fromEntries(
      ["react", "react-dom"]
        .filter(name => manifest.dependencies?.[name])
        .map(name => [name, manifest.dependencies[name]]),
    ) as Record<string, string>,
  };
}

const declarationTypeOwners: Record<string, string> = {
  "@types/node": "26.6.5",
  "puppeteer-core": "25.13.0",
  execa: "5.1.1",
  "source-map": "0.8.0",
  zod: "4.5.4",
};

/** Install the real archive in one unrelated, credential-free temporary consumer. */
export async function qualifyPackageConsumer(
  archive: string,
  options: { typesArchive?: string; typesVersion?: string } = {},
) {
  if (!isAbsolute(archive)) throw new TypeError("Package archive must be absolute");
  if (options.typesArchive && options.typesVersion) throw new TypeError("Select one exact types package source");
  let types: { source: "archive" | "registry"; version: string; sha256?: string } | undefined;
  if (options.typesArchive) {
    if (!isAbsolute(options.typesArchive)) throw new TypeError("Types archive must be absolute");
    const bytes = await Bun.file(options.typesArchive).bytes();
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("Types archive exceeds its bound");
    const files = await new Bun.Archive(bytes).files();
    const manifest = await files.get("package/package.json")?.text();
    const value = manifest ? JSON.parse(manifest) : undefined;
    const declarations = await files.get("package/bun.d.ts")?.text();
    if (
      value?.name !== "@aphrody/bun-types" ||
      typeof value.version !== "string" ||
      !declarations ||
      !/\bclass Video\b/.test(declarations)
    )
      throw new Error("A real Bun types archive with native Video declarations is required");
    types = {
      source: "archive",
      version: value.version,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
  } else if (options.typesVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.typesVersion))
      throw new TypeError("Types registry version must be exact");
    types = { source: "registry", version: options.typesVersion };
  }
  const snapshot = await inspectPackageArchive(await Bun.file(archive).bytes());
  const root = await mkdtemp(join(tmpdir(), "bun-video-package-consumer-"));
  const checkout = resolve(import.meta.dir, "../../..");
  const member = relative(checkout, root);
  if (!member.startsWith("..") && !isAbsolute(member))
    throw new Error("Consumer must remain outside the source checkout");
  await Bun.write(join(root, "empty.npmrc"), "");
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      name: "bun-video-consumer-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@aphrody/bun-video": "file:" + archive.replaceAll("\\", "/"),
        ...snapshot.qualificationPeers,
        ...snapshot.consumerReact,
        // The declaration surface names these type owners; the consumer must install them to check the public types.
        ...(types ? declarationTypeOwners : {}),
        ...(types
          ? {
              "@aphrody/bun-types": options.typesArchive
                ? "file:" + options.typesArchive.replaceAll("\\", "/")
                : types.version,
              "@types/react": "19.2.7",
              "@types/react-dom": "19.2.3",
            }
          : {}),
      },
    }),
  );
  const env = {
    ...(Bun.env.SystemRoot ? { SystemRoot: Bun.env.SystemRoot } : {}),
    PATH: Bun.env.PATH ?? "",
    TEMP: Bun.env.TEMP ?? tmpdir(),
    TMP: Bun.env.TMP ?? tmpdir(),
    APHRODY_HOME: join(root, "home"),
    BUN_VIDEO_CATALOG_BACKEND: "sqlite",
    NPM_CONFIG_USERCONFIG: join(root, "empty.npmrc"),
  };
  const install = Bun.spawn(
    [process.execPath, "--no-env-file", "install", "--production", "--ignore-scripts", "--no-progress"],
    {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 120_000,
    },
  );
  const installed = await install.exited;
  if (installed !== 0 || install.signalCode)
    throw new Error("Package consumer installation failed or exceeded its deadline");
  let typesManifestSha256: string | undefined;
  if (types) {
    const bytes = await Bun.file(join(root, "node_modules/@aphrody/bun-types/package.json")).bytes();
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error("Installed Bun types manifest exceeds its bound");
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (manifest.name !== "@aphrody/bun-types" || manifest.version !== types.version)
      throw new Error("Installed Bun types do not match the exact selected package");
    typesManifestSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }
  await Bun.write(
    join(root, "probe.ts"),
    `import {fileURLToPath} from 'node:url';
const result=[];
for(const name of ${JSON.stringify(snapshot.exports)}) {
  try { const api=await import('@aphrody/bun-video'+(name==='.'?'':name.slice(1)));
    result.push({export:name,ok:true,symbols:Object.keys(api).length});
  } catch(error) { result.push({export:name,ok:false,name:error.name}); }
}
const checks={};
try {
  const main=await import('@aphrody/bun-video');
  const remotionCore=await main.loadRemotionCore();
  checks.interpolation=remotionCore.interpolate(5,[0,10],[0,100])===50;
  const React=await import('react');const dom=await import('react-dom/server');
  const remotion=await import('@aphrody/bun-video/remotion');
  const html=dom.renderToStaticMarkup(React.createElement(remotion.AbsoluteFill,null,'consumer-render-fixture'));
  checks.reactDispatcher=html.includes('consumer-render-fixture')&&html.includes('position:absolute');
  checks.engineAlias=(await import('@aphrody/bun-video/engine'))===main;
  const hls=await import('@aphrody/bun-video/hls');
  checks.hlsAsset=await Bun.file(hls.getHlsBrowserAssetPath()).exists();
  const dash=await import('@aphrody/bun-video/dash');
  const parsed=dash.inspectDashManifest('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation width="320" height="180" bandwidth="1234"/></AdaptationSet></Period></MPD>');
  checks.dashMetadata=parsed.periodCount===1&&parsed.representations[0].width===320&&parsed.representations[0].height===180;
  using catalog=new main.VideoCatalog(import.meta.dir+'/consumer-fixture.sqlite');
  catalog.registerProvider({id:'synthetic',name:'Synthetic',family:'test'});
  checks.sqliteCatalogue=catalog.listProviders().some(provider=>provider.id==='synthetic');
  const worker=new Worker(new URL('./frame-worker.ts',import.meta.resolve('@aphrody/bun-video')),{type:'module'});
  try { const message=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Worker deadline')),5000);
    worker.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
    worker.onerror=error=>{clearTimeout(timer);reject(error);};
    worker.postMessage({type:'capture',plan:{frameStride:0}});
  });checks.workerValidation=message.type==='error'&&message.message.includes('Invalid frame stride');
  } finally {worker.terminate();}
  const taskPath=import.meta.dir+'/worker-fixture.json';const resultPath=import.meta.dir+'/worker-result.json';
  await Bun.write(taskPath,JSON.stringify({engine:'unsupported'}));
  const videoWorker=Bun.spawn([process.execPath,fileURLToPath(new URL('./video-worker-entry.ts',import.meta.resolve('@aphrody/bun-video'))),taskPath,resultPath],{stdin:'ignore',stdout:'ignore',stderr:'ignore',timeout:5000});
  const workerCode=await videoWorker.exited;
  const videoResult=await Bun.file(resultPath).json();
  checks.videoWorkerValidation=workerCode===1&&!videoWorker.signalCode&&videoResult.ok===false&&videoResult.error==='Unknown video engine';
} catch { checks.mainBehavior=false; }
console.log(JSON.stringify({runtime:Bun.version,revision:Bun.revision,exports:result,checks}));
`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", "probe.ts"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || child.signalCode || stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024)
    throw new Error("Package consumer import probe failed or exceeded its bounds");
  const report = JSON.parse(stdout);
  if (!Array.isArray(report.exports) || report.exports.length !== snapshot.exports.length)
    throw new Error("Package consumer did not report every public export");
  const manifest = await Bun.file(join(root, "node_modules/@aphrody/bun-video/package.json")).json();
  const helpMarkers: Record<string, string[]> = {
    "": ["bun-video capabilities", "bun-video mcp", "bun-video encode", "bun-video remotion"],
    chrome: ["Crunchyroll", "--check", "--install"],
    crunchyroll: ["bun-video crunchyroll", "watch", "serve"],
    dash: ["bun-video dash", "--live-config"],
    har: ["bun-video har", "--har"],
    hls: ["bun-video hls", "--prepare"],
    keychain: ["bun-video keychain", "--migrate", "--check"],
    shortcuts: ["crunchyroll-shortcuts", "PWA:"],
    webgpu: ["bun-video webgpu", "workgroups"],
    workers: ["bun-video workers", "--workers"],
    network: ["network-window", "--endpoint"],
  };
  if (snapshot.bins.length !== 1 || snapshot.bins[0] !== "bun-video")
    throw new Error("Public CLI must be the single bun-video executable");
  report.clis = [];
  for (const [subcommand, markers] of Object.entries(helpMarkers)) {
    const name = subcommand ? "bun-video " + subcommand : "bun-video";
    const cli = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(root, "node_modules/@aphrody/bun-video", manifest.bin["bun-video"]),
        ...(subcommand ? [subcommand] : []),
        "--help",
      ],
      { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    report.clis.push({
      name,
      passed:
        code === 0 &&
        !cli.signalCode &&
        stderr.length === 0 &&
        stdout.length <= 1024 * 1024 &&
        markers.every(marker => stdout.includes(marker)),
    });
  }
  report.checks.publicCLIs =
    report.clis.length === Object.keys(helpMarkers).length &&
    report.clis.every((cli: { passed: boolean }) => cli.passed);
  let typeCheck;
  if (types) {
    await Bun.write(
      join(root, "type-probe.ts"),
      `import {loadRemotionCore, VideoCatalog} from "@aphrody/bun-video";
import {VideoWorkerPool,UnifiedVideoPipeline,VideoCookieVault} from "@aphrody/bun-video";
import {VideoWorkerPool as Workers} from "@aphrody/bun-video/workers";
import {UnifiedVideoPipeline as Workflow} from "@aphrody/bun-video/workflow";
import {VideoCookieVault as Vault} from "@aphrody/bun-video/video-cookies";
declare const worker:InstanceType<typeof Workers>;
declare const workflow:InstanceType<typeof Workflow>;
declare const vault:InstanceType<typeof Vault>;
const sharedWorker:VideoWorkerPool=worker;
const sharedWorkflow:UnifiedVideoPipeline=workflow;
const sharedVault:VideoCookieVault=vault;
import {inspectDashManifest} from "@aphrody/bun-video/dash";
const remotion=await loadRemotionCore();
const value:number=remotion.interpolate(5,[0,10],[0,100]);
async function nativeFrame(video:Bun.Video){const metadata=await video.metadata();const rgba=await video.frame(0).resize(64).rgba();return {metadata,rgba};}
const available:boolean=Bun.Video.available;
export {value, VideoCatalog, inspectDashManifest, nativeFrame, available};\n`,
    );
    await Bun.write(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: ["@aphrody/bun-types"],
          lib: ["ESNext", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
          jsx: "react-jsx",
          allowImportingTsExtensions: true,
        },
        include: ["type-probe.ts"],
      }),
    );
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "check", "--threads=1", "--project", "tsconfig.json", "--noEmit"],
      {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (stdout.length + stderr.length > 4 * 1024 * 1024)
      throw new Error("Consumer type diagnostics exceed their bound");
    typeCheck = {
      source: types.source,
      version: types.version,
      sha256: types.sha256,
      manifestSha256: typesManifestSha256,
      passed: code === 0 && !child.signalCode,
      diagnostics: (stdout + stderr).match(/error TS\d+/g)?.length ?? 0,
    };
    await Bun.write(join(root, "type-diagnostics.log"), stdout + stderr);
    report.checks.types = typeCheck.passed;
  }
  return {
    ...snapshot,
    runtime: report.runtime,
    revision: report.revision,
    exports: report.exports,
    checks: report.checks,
    clis: report.clis,
    consumer: root,
    types: typeCheck,
  };
}

if (import.meta.main) {
  const archive = Bun.argv[2];
  if (!archive) throw new Error("Usage: bun scripts/qualify-package.ts /absolute/package.tgz");
  const report = await qualifyPackageConsumer(archive, Bun.argv[3] ? { typesArchive: Bun.argv[3] } : {});
  console.log(JSON.stringify(report, null, 2));
  if (
    report.exports.some((entry: { ok: boolean }) => !entry.ok) ||
    Object.values(report.checks).some(value => value !== true)
  )
    process.exitCode = 1;
}
