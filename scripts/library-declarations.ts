import { cp, mkdir, readdir, realpath, rm, symlink, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as TypeScript from "../mediabunny/node_modules/typescript";
import type * as ApiExtractor from "../mediabunny/node_modules/@microsoft/api-extractor";
import { absorbedFamilies, familyManifests } from "./modules";
import { verifiedLibraryPlan } from "./library-plan";

type CompilerOptions = TypeScript.CompilerOptions;
const packageRoot = resolve(import.meta.dir, "..");

/** Preserve whole-module types using namespace imports supported by the installed extractor. */
function declarationNamespaceImports(
  ts: typeof TypeScript,
): TypeScript.TransformerFactory<TypeScript.SourceFile | TypeScript.Bundle> {
  return context => {
    const transform = (source: TypeScript.SourceFile) => {
      const names = new Set<string>();
      const collect = (node: TypeScript.Node) => {
        if (ts.isIdentifier(node)) names.add(node.text);
        ts.forEachChild(node, collect);
      };
      collect(source);
      const imports = new Map<string, TypeScript.Identifier>();
      let reactNamespaceUsed = false;
      const visit = (node: TypeScript.Node): TypeScript.VisitResult<TypeScript.Node> => {
        if (ts.isQualifiedName(node)) {
          let root: TypeScript.EntityName = node;
          while (ts.isQualifiedName(root)) root = root.left;
          if (root.text === "React") reactNamespaceUsed = true;
        }
        if (
          ts.isImportTypeNode(node) &&
          node.isTypeOf &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        ) {
          const path = node.argument.literal.text;
          let alias = imports.get(path);
          if (!alias) {
            let name = "_BunVideoModule" + imports.size;
            while (names.has(name)) name += "_";
            names.add(name);
            alias = context.factory.createIdentifier(name);
            imports.set(path, alias);
          }
          // typeof import("x").a.b keeps its member chain: the extractor drops a typeof import() with a qualifier.
          let entity: TypeScript.EntityName = alias;
          if (node.qualifier) {
            const parts: TypeScript.Identifier[] = [];
            let qualifier: TypeScript.EntityName = node.qualifier;
            while (ts.isQualifiedName(qualifier)) {
              parts.unshift(qualifier.right);
              qualifier = qualifier.left;
            }
            parts.unshift(qualifier as TypeScript.Identifier);
            for (const part of parts) entity = context.factory.createQualifiedName(entity, part);
          }
          return context.factory.createTypeQueryNode(entity, node.typeArguments);
        }
        return ts.visitEachChild(node, visit, context);
      };
      const updated = ts.visitEachChild(source, visit, context);
      const reactBound = source.statements.some(
        statement =>
          (ts.isImportDeclaration(statement) &&
            statement.importClause &&
            (statement.importClause.name?.text === "React" ||
              (statement.importClause.namedBindings &&
                ts.isNamespaceImport(statement.importClause.namedBindings) &&
                statement.importClause.namedBindings.name.text === "React"))) ||
          ("name" in statement &&
            statement.name &&
            ts.isIdentifier(statement.name as TypeScript.Node) &&
            (statement.name as TypeScript.Identifier).text === "React"),
      );
      return context.factory.updateSourceFile(updated, [
        ...(reactNamespaceUsed && !reactBound
          ? [
              context.factory.createImportDeclaration(
                undefined,
                context.factory.createImportClause(
                  true,
                  undefined,
                  context.factory.createNamespaceImport(context.factory.createIdentifier("React")),
                ),
                context.factory.createStringLiteral("react"),
              ),
            ]
          : []),
        ...[...imports].map(([path, alias]) =>
          context.factory.createImportDeclaration(
            undefined,
            context.factory.createImportClause(true, undefined, context.factory.createNamespaceImport(alias)),
            context.factory.createStringLiteral(path),
          ),
        ),
        ...updated.statements,
      ]);
    };
    return node =>
      ts.isBundle(node) ? context.factory.updateBundle(node, node.sourceFiles.map(transform)) : transform(node);
  };
}

export async function producerReactTypes(root = packageRoot) {
  const manifest = await Bun.file(join(root, "package.json")).json();
  const paths: Record<string, string[]> = {};
  for (const [name, module] of [
    ["@types/react", "react"],
    ["@types/react-dom", "react-dom"],
  ] as const) {
    // Resolve the catalog-pinned version inside this package's own install store, not the workspace root's
    // (which pins a different React major and lives outside the package).
    const version = manifest.workspaces.catalog[name];
    const storeName = `${name.replace("/", "+")}@${version}`;
    const store = join(root, "node_modules/.bun");
    const matches = (await readdir(store)).filter(entry => entry === storeName || entry.startsWith(storeName + "+"));
    if (matches.length !== 1)
      throw new Error("Producer React declarations are not installed at the captured catalog version");
    const file = join(store, matches[0]!, "node_modules", name, "package.json");
    const metadata = await Bun.file(file).json();
    if (metadata.name !== name || metadata.version !== version)
      throw new Error("Producer React declarations diverge from the captured catalog");
    const prefix = "./" + relative(root, dirname(file)).replaceAll("\\", "/");
    if (prefix.startsWith("./../")) throw new Error("Producer React types escape the captured package owners");
    paths[module] = [prefix + "/index.d.ts"];
    paths[module + "/*"] = [prefix + "/*.d.ts"];
  }
  return paths;
}

export async function declarationTools(root = packageRoot) {
  const owner = join(root, "mediabunny");
  const compilerPath = Bun.resolveSync("typescript", owner);
  const extractorPath = Bun.resolveSync("@microsoft/api-extractor", owner);
  const compiler = (await import(compilerPath)) as typeof TypeScript;
  const extractor = (await import(extractorPath)) as typeof ApiExtractor;
  const compilerManifest = await Bun.file(Bun.resolveSync("typescript/package.json", owner)).json();
  const extractorManifest = await Bun.file(Bun.resolveSync("@microsoft/api-extractor/package.json", owner)).json();
  if ((await realpath(Bun.resolveSync("typescript", dirname(extractorPath)))) !== (await realpath(compilerPath)))
    throw new Error("API Extractor and declarations must share the same installed TypeScript owner");
  if (
    compiler.version !== "5.9.3" ||
    compilerManifest.version !== "5.9.3" ||
    extractorManifest.version !== "7.59.4" ||
    typeof compiler.createProgram !== "function" ||
    typeof extractor.Extractor.invoke !== "function"
  )
    throw new Error("Declarations require the captured MediaBunny compiler/extractor owners");
  return {
    compiler,
    extractor,
    versions: { typescript: compilerManifest.version, extractor: extractorManifest.version },
    inputs: [compilerPath, extractorPath],
  };
}

/** Emit inferred declarations once, then roll up public owners using the existing compiler state. */
export async function emitDeclarationSurface(
  options: {
    root: string;
    stage: string;
    output: string;
    entries: string[];
    compilerOptions: CompilerOptions;
    bundledPackages: string[];
    additionalSources?: string[];
    ambientDeclarations?: Array<{ source: string; name: string; license: string }>;
    canonicalBunTypes?: string;
    checkOnly?: boolean;
  },
  tools: Awaited<ReturnType<typeof declarationTools>>,
) {
  const { compiler: ts, extractor: api } = tools;
  const traceEnabled = Bun.env.BUN_VIDEO_DECLARATION_TRACE === "1";
  const started = performance.now();
  const io = { sources: 0, sourceMs: 0, reads: 0, readMs: 0, exists: 0, existsMs: 0 };
  const trace = (phase: string) => {
    if (traceEnabled) {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      console.error(
        JSON.stringify({
          declarations: phase,
          elapsedMs: Math.round(performance.now() - started),
          rssBytes: memory.rss,
          heapBytes: memory.heapUsed,
          cpuMs: Math.round((cpu.user + cpu.system) / 1000),
          io,
        }),
      );
    }
  };
  const root = resolve(options.root);
  const stage = resolve(options.stage);
  const output = resolve(options.output);
  const sourceRoot = resolve(options.compilerOptions.rootDir ?? root);
  if (isAbsolute(relative(sourceRoot, root)) || relative(sourceRoot, root).startsWith(".."))
    throw new Error("Declaration source root does not contain its package owner");
  const emittedMember = (source: string) => relative(sourceRoot, resolve(root, source));
  if (options.entries.length > 64 || !options.entries.length)
    throw new Error("Public declaration entries exceed their bound");
  for (const entry of options.entries) {
    const member = relative(root, resolve(root, entry));
    if (isAbsolute(member) || member.startsWith("..")) throw new Error("Declaration entry escapes its owner");
  }
  for (const source of options.additionalSources ?? []) {
    const member = relative(sourceRoot, resolve(source));
    if (isAbsolute(member) || member.startsWith("..") || !source.endsWith(".ts"))
      throw new Error("Additional declaration owner escapes the source root");
  }
  await mkdir(stage, { recursive: true });
  await mkdir(output, { recursive: true });
  const compilerOptions: CompilerOptions = {
    ...options.compilerOptions,
    baseUrl: options.compilerOptions.baseUrl ?? root,
    noEmit: false,
    noEmitOnError: true,
    skipLibCheck: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    outDir: stage,
    rootDir: sourceRoot,
    incremental: false,
    composite: false,
  };
  if (options.canonicalBunTypes) {
    const source = resolve(options.canonicalBunTypes);
    const metadata = await Bun.file(join(source, "package.json")).json();
    if (metadata.name !== "@aphrody/bun-types") throw new Error("Canonical Bun type owner is invalid");
    const typeRoot = join(stage, "compiler-types");
    const link = join(typeRoot, "@aphrody/bun-types");
    await mkdir(dirname(link), { recursive: true });
    try {
      if (!(await lstat(link)).isSymbolicLink() || (await realpath(link)) !== (await realpath(source)))
        throw new Error("Canonical type link belongs to another owner");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await symlink(source, link, "junction");
    }
    compilerOptions.typeRoots = [typeRoot, ...(compilerOptions.typeRoots ?? [])];
    compilerOptions.types = [...new Set([...(compilerOptions.types ?? []), "@aphrody/bun-types"])];
  }
  const compilerHost = ts.createCompilerHost(compilerOptions);
  if (traceEnabled) {
    const getSource = compilerHost.getSourceFile;
    compilerHost.getSourceFile = (...args) => {
      const start = performance.now();
      const source = getSource(...args);
      io.sourceMs += performance.now() - start;
      if (++io.sources % 1024 === 0) trace("source-progress");
      return source;
    };
    const read = compilerHost.readFile;
    compilerHost.readFile = file => {
      const start = performance.now();
      const result = read(file);
      io.readMs += performance.now() - start;
      if (++io.reads % 4096 === 0) trace("read-progress");
      return result;
    };
    const exists = compilerHost.fileExists;
    compilerHost.fileExists = file => {
      const start = performance.now();
      const result = exists(file);
      io.existsMs += performance.now() - start;
      if (++io.exists % 4096 === 0) trace("resolution-progress");
      return result;
    };
  }
  trace("program");
  const program = ts.createProgram(
    [...options.entries.map(entry => resolve(root, entry)), ...(options.additionalSources ?? [])],
    compilerOptions,
    compilerHost,
  );
  trace("diagnostics");
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
    const report = diagnostics.slice(0, 500).map(diagnostic => ({
      code: diagnostic.code,
      file: diagnostic.file ? relative(root, diagnostic.file.fileName).replaceAll("\\", "/") : undefined,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
    await Bun.write(
      join(stage, "declaration-diagnostics.json"),
      JSON.stringify(
        {
          errors: diagnostics.length,
          diagnostics: report,
          categories: Object.fromEntries(
            [...new Set(diagnostics.map(diagnostic => diagnostic.code))].map(code => [
              code,
              diagnostics.filter(diagnostic => diagnostic.code === code).length,
            ]),
          ),
          bunOwners: program
            .getSourceFiles()
            .filter(file => /(?:bun-types|@types[\\/]bun)[\\/].*(?:index|bun)\.d\.ts$/.test(file.fileName))
            .map(file => relative(root, file.fileName).replaceAll("\\", "/")),
        },
        null,
        2,
      ),
    );
    throw new Error(`Canonical declaration compiler reported ${diagnostics.length} diagnostics`);
  }
  if (options.checkOnly)
    return {
      tools: tools.versions,
      declarations: [],
      inputs: [],
      sources: program.getSourceFiles().length,
      checked: true,
    };
  trace("inputs");
  const inputs = await Promise.all(program.getSourceFiles().map(file => realpath(file.fileName)));
  const emitted: string[] = [];
  trace("emit");
  const result = program.emit(
    undefined,
    (filename, text) => {
      const member = relative(stage, filename);
      if (isAbsolute(member) || member.startsWith("..") || !filename.endsWith(".d.ts"))
        throw new Error("Declaration compiler output escapes its owned stage");
      ts.sys.writeFile(filename, text);
      emitted.push(filename);
    },
    undefined,
    true,
    { afterDeclarations: [declarationNamespaceImports(ts)] },
  );
  if (result.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
    const diagnostics = result.diagnostics.slice(0, 100).map(diagnostic => ({
      code: diagnostic.code,
      file: diagnostic.file ? relative(root, diagnostic.file.fileName).replaceAll("\\", "/") : undefined,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
    await Bun.write(
      join(stage, "declaration-emit-diagnostics.json"),
      JSON.stringify({ emitSkipped: result.emitSkipped, diagnostics }, null, 2),
    );
    throw new Error(
      `Canonical declaration emission failed\n${diagnostics.map(diagnostic => `${diagnostic.file}: TS${diagnostic.code} ${diagnostic.message}`).join("\n")}`,
    );
  }
  // JSON inputs have no declaration output; TypeScript marks the whole emit as skipped for them.
  const emittedPaths = new Set(emitted.map(filename => resolve(filename)));
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      source.fileName.endsWith(".json") ||
      program.isSourceFileFromExternalLibrary(source)
    )
      continue;
    const declaration = resolve(
      stage,
      relative(sourceRoot, source.fileName).replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, ".d.ts"),
    );
    if (!emittedPaths.has(declaration))
      throw new Error(`Declaration compiler omitted an owned source: ${relative(root, source.fileName)}`);
  }
  if (emitted.length > 6000) throw new Error("Emitted declaration closure exceeds its bound");
  const declarationFor = (source: string) => source.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, ".d.ts");
  // The canonical owner declares "bun" and "bun:*" as ambient modules; a file alias would shadow them.
  const ambientBunAlias = (name: string) =>
    options.canonicalBunTypes !== undefined && (name === "bun" || name.startsWith("bun:"));
  const paths = Object.fromEntries(
    Object.entries(compilerOptions.paths ?? {})
      .filter(([name]) => !ambientBunAlias(name))
      .map(([name, targets]) => [
        name,
        targets.map(target => {
          const source = resolve(root, target);
          const member = relative(sourceRoot, source);
          return !isAbsolute(member) &&
            !member.startsWith("..") &&
            !source.endsWith(".d.ts") &&
            /\.(?:[cm]?[jt]s|[jt]sx)$/.test(member)
            ? join(stage, declarationFor(emittedMember(target)))
            : source;
        }),
      ]),
  );
  const jsonOptions = { ...compilerOptions };
  delete jsonOptions.pathsBasePath;
  delete jsonOptions.configFilePath;
  delete jsonOptions.configFile;
  const overrideTsconfig = {
    compilerOptions: {
      ...jsonOptions,
      target:
        compilerOptions.target === undefined || compilerOptions.target === ts.ScriptTarget.ESNext
          ? "ESNext"
          : ts.ScriptTarget[compilerOptions.target],
      module: ts.ModuleKind[compilerOptions.module ?? ts.ModuleKind.ESNext],
      moduleResolution: ts.ModuleResolutionKind[compilerOptions.moduleResolution ?? ts.ModuleResolutionKind.Bundler],
      jsx:
        compilerOptions.jsx === undefined
          ? undefined
          : {
              [ts.JsxEmit.None]: undefined,
              [ts.JsxEmit.Preserve]: "preserve",
              [ts.JsxEmit.React]: "react",
              [ts.JsxEmit.ReactJSX]: "react-jsx",
              [ts.JsxEmit.ReactJSXDev]: "react-jsxdev",
              [ts.JsxEmit.ReactNative]: "react-native",
            }[compilerOptions.jsx],
      lib: compilerOptions.lib?.map(name => name.replace(/^lib\./, "").replace(/\.d\.ts$/, "")),
      noEmit: true,
      paths,
      rootDir: stage,
      skipLibCheck: false,
    },
    files: emitted,
  };
  trace("configure-rollup");
  const aggregate = join(stage, "public-aggregate.d.ts");
  // Emitted declarations reference the ambient "bun" module; the analysis program must load its owner explicitly.
  const bunReference = options.canonicalBunTypes ? '/// <reference types="@aphrody/bun-types" />\n' : "";
  const exports = options.entries.map(
    (entry, index) =>
      `export * as Public${index} from ${JSON.stringify(
        "./" +
          relative(stage, join(stage, declarationFor(emittedMember(entry))))
            .replaceAll("\\", "/")
            .replace(/\.d\.ts$/, ""),
      )};`,
  );
  await Bun.write(aggregate, bunReference + exports.join("\n") + "\n");
  const prepare = () =>
    api.ExtractorConfig.prepare({
      configObject: {
        projectFolder: root,
        mainEntryPointFilePath: aggregate,
        bundledPackages: options.bundledPackages,
        compiler: { overrideTsconfig },
        apiReport: { enabled: false },
        docModel: { enabled: false },
        tsdocMetadata: { enabled: false },
        dtsRollup: { enabled: true, untrimmedFilePath: join(output, "_surface.d.ts") },
        messages: {
          compilerMessageReporting: { default: { logLevel: api.ExtractorLogLevel.Error } },
          extractorMessageReporting: { default: { logLevel: api.ExtractorLogLevel.Warning } },
          tsdocMessageReporting: { default: { logLevel: api.ExtractorLogLevel.Warning } },
        },
      },
      configObjectFullPath: undefined,
      packageJsonFullPath: join(root, "package.json"),
    });
  trace("rollup-state");
  const parsedRollup = ts.parseJsonConfigFileContent(overrideTsconfig, ts.sys, root);
  if (parsedRollup.errors.length) throw new Error("Public declaration analysis configuration is invalid");
  delete parsedRollup.options.rootDir;
  const host = ts.createCompilerHost(parsedRollup.options);
  const canonicalName = ts.sys.useCaseSensitiveFileNames
    ? (name: string) => name
    : (name: string) => name.toLowerCase();
  const sourceResolution = ts.createModuleResolutionCache(root, canonicalName, compilerOptions);
  const stageResolution = ts.createModuleResolutionCache(stage, canonicalName, parsedRollup.options);
  const declarationResolution = (module: TypeScript.ResolvedModuleFull | undefined) => {
    if (!module || module.resolvedFileName.endsWith(".d.ts")) return module;
    const member = relative(sourceRoot, module.resolvedFileName);
    if (isAbsolute(member) || member.startsWith("..")) return module;
    const declaration = resolve(stage, declarationFor(member));
    return emittedPaths.has(declaration)
      ? { ...module, resolvedFileName: declaration, extension: ts.Extension.Dts }
      : module;
  };
  host.resolveModuleNames = (names, containingFile) =>
    names.map(name => {
      if (ambientBunAlias(name)) return undefined;
      const relativeFile = relative(stage, containingFile);
      const original =
        isAbsolute(relativeFile) || relativeFile.startsWith("..")
          ? containingFile
          : resolve(sourceRoot, relativeFile.replace(/\.d\.ts$/, ".ts"));
      const source = () =>
        declarationResolution(
          ts.resolveModuleName(name, original, compilerOptions, ts.sys, sourceResolution).resolvedModule,
        );
      // Bare dependencies belong to the original importer, including its exact package version.
      if (!name.startsWith(".") && !isAbsolute(name)) return source();
      return (
        ts.resolveModuleName(name, containingFile, parsedRollup.options, ts.sys, stageResolution).resolvedModule ??
        source()
      );
    });
  const rollupProgram = ts.createProgram([...emitted, aggregate], parsedRollup.options, host);
  const state: ApiExtractor.CompilerState = { program: rollupProgram };
  if (
    typeof rollupProgram?.getCompilerOptions !== "function" ||
    rollupProgram.getCompilerOptions().skipLibCheck !== false
  )
    throw new Error("Extractor compiler state is not the pinned strict TypeScript program");
  const rollupDiagnostics = ts.getPreEmitDiagnostics(rollupProgram);
  if (rollupDiagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
    const diagnostics = rollupDiagnostics.slice(0, 100).map(diagnostic => ({
      code: diagnostic.code,
      file: diagnostic.file ? relative(root, diagnostic.file.fileName).replaceAll("\\", "/") : undefined,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
    await Bun.write(join(stage, "declaration-rollup-diagnostics.json"), JSON.stringify({ diagnostics }, null, 2));
    throw new Error(
      `Rolled declaration compiler reported ${rollupDiagnostics.length} diagnostics\n${diagnostics
        .slice(0, 20)
        .map(diagnostic => `${diagnostic.file}: TS${diagnostic.code} ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  const outputs = [];
  {
    trace("common-surface");
    const configuration = prepare();
    if (!configuration.untrimmedFilePath) throw new Error("Public declaration rollup has no owned output");
    await mkdir(dirname(configuration.untrimmedFilePath), { recursive: true });
    const errors: string[] = [];
    const result = api.Extractor.invoke(configuration, {
      localBuild: true,
      compilerState: state,
      messageCallback(message) {
        if (message.logLevel === api.ExtractorLogLevel.Error && errors.length < 20) errors.push(message.text);
        message.handled = true;
      },
    });
    if (!result.succeeded || result.errorCount)
      throw new Error(`Public declaration rollup failed\n${errors.join("\n")}`);
    const file = Bun.file(configuration.untrimmedFilePath);
    const bytes = await file.bytes();
    if (bytes.length > 4 * 1024 * 1024) throw new Error("Public declaration exceeds its file bound");
    outputs.push({
      name: relative(output, configuration.untrimmedFilePath).replaceAll("\\", "/"),
      path: configuration.untrimmedFilePath,
      bytes: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      warnings: result.warningCount,
    });
  }
  const checker = program.getTypeChecker();
  for (const [index, entry] of options.entries.entries()) {
    const source = program.getSourceFile(resolve(root, entry));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error("Public declaration owner has no module symbol");
    const filename = join(output, declarationFor(entry));
    const common = "./" + relative(dirname(filename), join(output, "_surface")).replaceAll("\\", "/");
    const members = checker.getExportsOfModule(symbol);
    const text =
      `import {Public${index}} from ${JSON.stringify(common)};\n` +
      members
        .map(member =>
          member.name === "default"
            ? `export default Public${index}.default;`
            : `export import ${member.name} = Public${index}.${member.name};`,
        )
        .join("\n") +
      "\n";
    await Bun.write(filename, text);
    const bytes = await Bun.file(filename).bytes();
    outputs.push({
      name: declarationFor(entry),
      path: filename,
      bytes: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      warnings: 0,
    });
  }
  const references = [];
  for (const ambient of options.ambientDeclarations ?? []) {
    if (!ambient.name.startsWith("ambient/") || ambient.name.includes("..") || !ambient.name.endsWith(".d.ts"))
      throw new Error("Ambient declaration payload escapes its owner");
    for (const [source, name] of [
      [ambient.source, ambient.name],
      [ambient.license, ambient.name + ".LICENSE"],
    ]) {
      const bytes = await Bun.file(source!).bytes();
      const path = join(output, name!);
      await Bun.write(path, bytes);
      inputs.push(await realpath(source!));
      outputs.push({
        name: name!,
        path,
        bytes: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        warnings: 0,
      });
    }
    references.push(`/// <reference path=${JSON.stringify("./" + ambient.name)} />`);
  }
  if (references.length) {
    const surface = outputs.find(file => file.name === "_surface.d.ts")!;
    // The ambient owner supplies these declarations; the emitted types directive would load a second copy of them.
    const emitted = (await Bun.file(surface.path).text()).replace(
      /^\/\/\/ <reference types="dom-mediacapture-transform" \/>\r?\n/m,
      "",
    );
    await Bun.write(surface.path, references.join("\n") + "\n" + emitted);
    const bytes = await Bun.file(surface.path).bytes();
    surface.bytes = bytes.length;
    surface.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }
  return {
    tools: tools.versions,
    declarations: outputs,
    inputs: [...new Set([...inputs, ...tools.inputs])],
    sources: emitted.length,
  };
}

export async function buildLibraryDeclarations(root = packageRoot, checkOnly = false) {
  const plan = await verifiedLibraryPlan(root);
  const { compiler } = await declarationTools(root);
  const config = compiler.readConfigFile(join(root, "tsconfig.check.json"), compiler.sys.readFile);
  if (config.error) throw new Error("Canonical source type configuration is unreadable");
  const parsed = compiler.parseJsonConfigFileContent(config.config, compiler.sys, root);
  if (parsed.errors.length) throw new Error("Canonical source type configuration is invalid");
  Object.assign((parsed.options.paths ??= {}), await producerReactTypes(root));
  // @babel/parser's typings are resolved from the global store, which has no @babel/types sibling; map the owned copy.
  parsed.options.paths["@babel/types"] = ["./node_modules/@babel/types/lib/index.d.ts"];
  parsed.options.typeRoots = [...new Set([...(parsed.options.typeRoots ?? []), join(root, "node_modules/@types")])];
  parsed.options.types = [...new Set([...(parsed.options.types ?? []), "dom-mediacapture-transform"])];
  parsed.options.rootDir = resolve(root, "../..");
  const sdkPath = await realpath(Bun.resolveSync("@aphrody/bun-runtime-sdk/video/hls", root));
  const sdkRoot = resolve(dirname(sdkPath), "../..");
  const sdkManifest = await Bun.file(join(sdkRoot, "package.json")).json();
  const captureRoot = dirname(
    Bun.resolveSync("@types/dom-mediacapture-transform/package.json", join(root, "mediabunny")),
  );
  const captureManifest = await Bun.file(join(captureRoot, "package.json")).json();
  if (captureManifest.name !== "@types/dom-mediacapture-transform" || captureManifest.version !== "0.1.11")
    throw new Error("MediaCapture declarations diverge from their pinned owner");
  const sdkEntry = sdkManifest.exports?.["./video/hls"];
  if (sdkManifest.name !== "@aphrody/bun-runtime-sdk" || sdkEntry !== "./src/video/hls.ts")
    throw new Error("Canonical runtime SDK HLS owner changed");
  if (
    sdkManifest.version !== (await Bun.file(join(root, "package.json")).json()).dependencies[sdkManifest.name] ||
    sdkPath !== (await realpath(join(sdkRoot, sdkEntry)))
  )
    throw new Error("Installed SDK HLS owner diverges from its package pin");
  // The installed SDK lives in the global store, outside the workspace source root. Its surface modules
  // only import node:*, bun and bun:* plus sibling files, so the pinned tree is copied into the owned build
  // tree and each exported subpath is analyzed from its copy, which lets its declarations be emitted.
  const sdkOwnedRoot = resolve(root, "../tmp/bun-video-build/owners/bun-runtime-sdk/src");
  await rm(dirname(sdkOwnedRoot), { recursive: true, force: true });
  await cp(join(sdkRoot, "src"), sdkOwnedRoot, { recursive: true });
  const sdkOwnedEntries = ["./gpu", "./browser", "./target", "./video/hls"];
  const sdkOwned: string[] = [];
  for (const key of sdkOwnedEntries) {
    const target = sdkManifest.exports?.[key];
    if (typeof target !== "string" || !target.startsWith("./src/") || !target.endsWith(".ts"))
      throw new Error("Canonical runtime SDK owner entry changed");
    const copy = join(sdkOwnedRoot, "..", target.slice(2));
    const copied = resolve(copy);
    if (!copied.startsWith(sdkOwnedRoot + sep)) throw new Error("Runtime SDK owner entry escapes its copy");
    sdkOwned.push(copied);
    parsed.options.paths["@aphrody/bun-runtime-sdk" + key.slice(1)] = [relative(root, copied).replaceAll("\\", "/")];
  }
  const manifests = await Promise.all(
    absorbedFamilies.map(async family =>
      Object.values(await familyManifests(join(root, family))).map(manifest => manifest.name),
    ),
  );
  const entries = [...new Set(Object.values(plan.sourceExports).map(source => source.slice(2)))];
  const surface = await emitDeclarationSurface(
    {
      root,
      stage: resolve(root, "../tmp/bun-video-build/declarations"),
      output: resolve(root, "../tmp/bun-video-build/declarations/public"),
      entries,
      additionalSources: sdkOwned,
      ambientDeclarations: [
        {
          source: join(captureRoot, "index.d.ts"),
          name: "ambient/dom-mediacapture-transform.d.ts",
          license: join(captureRoot, "LICENSE"),
        },
        {
          source: join(root, "scripts/ambient/html-in-canvas.d.ts"),
          name: "ambient/html-in-canvas.d.ts",
          license: join(root, "remotion/LICENSE.md"),
        },
      ],
      compilerOptions: parsed.options,
      bundledPackages: [
        ...manifests.flat(),
        "mediabunny",
        "@aphrody/bun-plugin-neon",
        sdkManifest.name,
        plan.manifest.name,
      ],
      canonicalBunTypes: resolve(root, "../bun-types"),
      checkOnly,
    },
    await declarationTools(root),
  );
  return {
    ...surface,
    ambientOwner: {
      name: captureManifest.name as string,
      version: captureManifest.version as string,
      source: join(captureRoot, "index.d.ts"),
      manifest: join(captureRoot, "package.json"),
    },
    sdkOwner: {
      name: sdkManifest.name as string,
      version: sdkManifest.version as string,
      manifest: join(sdkRoot, "package.json"),
      notice: join(sdkRoot, "LICENSE-APACHE"),
    },
  };
}

if (import.meta.main)
  console.log(JSON.stringify(await buildLibraryDeclarations(packageRoot, Bun.argv.includes("--check"))));
