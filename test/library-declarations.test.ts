import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declarationTools, emitDeclarationSurface } from "../scripts/library-declarations";

test("the installed canonical compiler rolls inferred public types across a workspace alias", async () => {
  const tools = await declarationTools();
  const root = await mkdtemp(join(tmpdir(), "bun-video-declaration-fixture-"));
  await mkdir(join(root, "src"));
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ name: "bun-video-declaration-fixture", version: "1.0.0" }),
  );
  await Bun.write(
    join(root, "src/choice.ts"),
    "/** @public */\nexport interface Choice {label:string;confidence:number}\n/** @public */\nexport const scoreFloor=0.9;\n/** @public */\nexport class ChoiceRecord { readonly #label:string; constructor(label:string){this.#label=label} value(){return this.#label} }\n",
  );
  await Bun.write(join(root, "src/pin.json"), JSON.stringify({ owner: "canonical" }));
  await Bun.write(
    join(root, "src/index.ts"),
    'import type {Choice} from "@fixture/choice";import pin from "./pin.json";export {ChoiceRecord} from "@fixture/choice";export type {Choice} from "@fixture/choice";\n/** @public */\nexport const owner=pin.owner;\n/** @public */\nexport const loadChoice=()=>import("@fixture/choice");\n/** @public */\nexport const decide=(choice:Choice)=>({...choice,accepted:choice.confidence>=0.9});\n',
  );
  await Bun.write(join(root, "src/other.ts"), 'export {ChoiceRecord} from "@fixture/choice";\n');
  const result = await emitDeclarationSurface(
    {
      root,
      stage: join(root, "stage"),
      output: join(root, "public"),
      entries: ["src/index.ts", "src/other.ts"],
      compilerOptions: tools.compiler.parseJsonConfigFileContent(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            resolveJsonModule: true,
            types: [],
            lib: ["ES5", "ES2015.Promise"],
            paths: { "@fixture/choice": ["./src/choice.ts"] },
          },
        },
        tools.compiler.sys,
        root,
      ).options,
      bundledPackages: ["@fixture/choice"],
    },
    tools,
  );
  expect(result.tools).toEqual({ typescript: "5.9.3", extractor: "7.59.4" });
  const text = await Bun.file(join(root, "public/_surface.d.ts")).text();
  expect(text).toContain("confidence: number");
  expect(text).toContain("accepted: boolean");
  expect(text).toContain("owner: string");
  expect(text).not.toContain("@fixture/choice");
  expect(text).not.toMatch(/\bany\b/);
  expect(result.declarations.length).toBe(3);
  const consumer = join(root, "consumer.ts");
  const consumerOptions = {
    target: tools.compiler.ScriptTarget.ESNext,
    module: tools.compiler.ModuleKind.ESNext,
    moduleResolution: tools.compiler.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: [],
    lib: ["lib.es5.d.ts"],
  };
  await Bun.write(
    consumer,
    'import {decide,loadChoice,ChoiceRecord} from "./public/src/index";import {ChoiceRecord as Other} from "./public/src/other";const nominal:ChoiceRecord=new Other("a");const accepted:boolean=decide({label:"a",confidence:0.95}).accepted;const floor:0.9=(await loadChoice()).scoreFloor;\n',
  );
  expect(
    tools.compiler
      .getPreEmitDiagnostics(tools.compiler.createProgram([consumer], consumerOptions))
      .map(diagnostic => tools.compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  await Bun.write(
    consumer,
    'import {decide} from "./public/src/index";const accepted:string=decide({label:"a",confidence:0.95}).accepted;\n',
  );
  expect(
    tools.compiler
      .getPreEmitDiagnostics(tools.compiler.createProgram([consumer], consumerOptions))
      .map(diagnostic => diagnostic.code),
  ).toContain(2322);
}, 180_000);

test("the pinned Linkedom declarations describe its partial DOM and preserve parsing", async () => {
  const { compiler: ts } = await declarationTools();
  const owner = Bun.resolveSync("linkedom/package.json", join(import.meta.dir, "../hyperframes/core"));
  const root = join(owner, "..");
  const source = await mkdtemp(join(tmpdir(), "bun-video-linkedom-types-"));
  const file = join(source, "consumer.ts");
  await Bun.write(
    file,
    `import {DOMParser} from ${JSON.stringify(join(root, "types/esm/index").replaceAll("\\", "/"))};\nconst document=new DOMParser().parseFromString('<html><body>hello</body></html>','text/html');\ndocument.querySelectorAll('body');\n// @ts-expect-error Linkedom documents do not implement the full browser Document.\nconst browserDocument:Document=document;\n`,
  );
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([file], {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    }),
  );
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  const { DOMParser } = await import(Bun.resolveSync("linkedom", join(import.meta.dir, "../hyperframes/core")));
  const document = new DOMParser().parseFromString(
    '<html><body><a href="/video">Bun Video</a></body></html>',
    "text/html",
  );
  expect(document.querySelectorAll("a").length).toBe(1);
  expect(document.querySelector("a")?.textContent).toBe("Bun Video");
  expect(document.querySelector("a")?.getAttribute("href")).toBe("/video");
  expect(document.toString()).toContain('<a href="/video">Bun Video</a>');
}, 180_000);

test("declaration analysis preserves dependency versions from each original importer", async () => {
  const tools = await declarationTools();
  const root = await mkdtemp(join(tmpdir(), "bun-video-declaration-owner-fixture-"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "bun-video-owner-fixture", version: "1.0.0" }));
  await Bun.write(
    join(root, "node_modules/fixture-owner/package.json"),
    JSON.stringify({ name: "fixture-owner", version: "3.0.0", types: "index.d.ts" }),
  );
  await Bun.write(join(root, "node_modules/fixture-owner/index.d.ts"), 'export interface Owner{label:"wrong";}\n');
  for (const [name, version] of [
    ["a", "1.0.0"],
    ["b", "2.0.0"],
  ]) {
    await Bun.write(
      join(root, `packages/${name}/node_modules/fixture-owner/package.json`),
      JSON.stringify({ name: "fixture-owner", version, types: "index.d.ts" }),
    );
    await Bun.write(
      join(root, `packages/${name}/node_modules/fixture-owner/index.d.ts`),
      `export interface Owner{label:${JSON.stringify(name)};}\n`,
    );
    await Bun.write(
      join(root, `packages/${name}/src/index.ts`),
      'import type {Owner} from "fixture-owner";/** @public */\nexport function chosen(value:Owner):Owner{return value;}\n',
    );
  }
  await emitDeclarationSurface(
    {
      root,
      stage: join(root, "stage"),
      output: join(root, "public"),
      entries: ["packages/a/src/index.ts", "packages/b/src/index.ts"],
      bundledPackages: ["fixture-owner"],
      compilerOptions: {
        strict: true,
        types: [],
        lib: ["lib.es5.d.ts"],
        target: tools.compiler.ScriptTarget.ESNext,
        module: tools.compiler.ModuleKind.ESNext,
        moduleResolution: tools.compiler.ModuleResolutionKind.Bundler,
      },
    },
    tools,
  );
  const consumer = join(root, "consumer.ts");
  await Bun.write(
    consumer,
    'import {chosen as a} from "./public/packages/a/src/index";import {chosen as b} from "./public/packages/b/src/index";const first:"a"=a({label:"a"}).label;const second:"b"=b({label:"b"}).label;\n',
  );
  const diagnostics = tools.compiler.getPreEmitDiagnostics(
    tools.compiler.createProgram([consumer], {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
      lib: ["lib.es5.d.ts"],
      target: tools.compiler.ScriptTarget.ESNext,
      module: tools.compiler.ModuleKind.ESNext,
      moduleResolution: tools.compiler.ModuleResolutionKind.Bundler,
    }),
  );
  expect(
    diagnostics.map(diagnostic => tools.compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
}, 180_000);
