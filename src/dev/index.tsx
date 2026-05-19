import html from "@elysiajs/html";
import { Elysia } from "elysia";
import { parseSync, visitorKeys } from "oxc-parser";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { injectIslandRuntime, getContentType } from "../runtime/utils";

type Component<Props = Record<string, unknown>> = (props: Props) => any;

interface StartServerOptions {
  root: string;
  port?: number;
}

interface BuildOptions {
  root: string;
  outDir?: string;
  minify?: boolean;
}

interface ProductionServerOptions {
  root: string;
  outDir?: string;
  port?: number;
}

interface BuildResult {
  outDir: string;
  routes: number;
  islands: number;
  assets: Array<{
    name: string;
    size: number;
    type: "route" | "island" | "runtime";
  }>;
}

interface MeidenConfig {
  appDir?: string;
  srcDir?: string;
}

interface AppModules {
  RootLayout: Component<{ children: unknown }>;
  routes: AppRoute[];
}

interface AppRoute {
  path: string;
  Page: Component;
  filePath: string;
}

interface LayoutWrapperProps {
  Page: Component;
}

interface IslandReference {
  source: string;
  exportName: string;
}

const moduleExtensions = [".tsx", ".ts", ".jsx", ".js"];
const configExtensions = [".ts", ".js", ".mjs", ".mts", ".cjs"];
const routeFilePattern = /(^|\/)page\.(tsx|ts|jsx|js)$/;
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const reactHooks = new Set([
  "useState",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useReducer",
  "useRef",
  "useMemo",
  "useCallback",
  "useTransition",
  "useDeferredValue",
  "useSyncExternalStore",
  "useImperativeHandle",
  "useOptimistic",
  "useActionState",
]);
const browserGlobals = new Set(["window", "document", "localStorage", "sessionStorage", "navigator"]);
const colors = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

function color(value: string | number, ansi: string) {
  return `${ansi}${value}${colors.reset}`;
}

function statusColor(status: number) {
  if (status >= 500) {
    return colors.red;
  }

  if (status >= 400) {
    return colors.yellow;
  }

  return colors.green;
}

function formatDuration(start: number) {
  const duration = performance.now() - start;

  if (duration < 1) {
    return `${Math.round(duration * 1000)}us`;
  }

  return duration < 10 ? `${duration.toFixed(2)}ms` : `${duration.toFixed(1)}ms`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function logRequest(method: string, path: string, status: number, startedAt: number) {
  console.log(
    [
      color(status, statusColor(status)),
      color(method.padEnd(4), colors.dim),
      path.padEnd(8),
      color(formatDuration(startedAt).padStart(6), colors.dim),
    ].join("  "),
  );
}

function hash(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function toPath(urlOrPath: string) {
  if (urlOrPath.startsWith("file://")) {
    return fileURLToPath(urlOrPath);
  }

  return urlOrPath;
}

function writeFileIfChanged(filePath: string, content: string) {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) {
    return;
  }

  writeFileSync(filePath, content);
}

function resolveAppModule(srcDir: string, name: string) {
  for (const extension of moduleExtensions) {
    const candidate = join(srcDir, `${name}${extension}`);

    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }

  throw new Error(`Could not find ${name}{${moduleExtensions.join(",")}} in ${srcDir}`);
}

function resolveImport(fromFile: string, specifier: string) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = resolve(dirname(toPath(fromFile)), specifier);

  if (existsSync(base) && statSync(base).isFile()) {
    return base;
  }

  for (const extension of moduleExtensions) {
    const candidate = `${base}${extension}`;

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const extension of moduleExtensions) {
    const candidate = join(base, `index${extension}`);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function parseModule(filePath: string) {
  const source = readFileSync(filePath, "utf8");

  return parseSync(filePath, source, {
    lang: filePath.endsWith("x") ? "tsx" : "ts",
    sourceType: "module",
    astType: "ts",
  });
}

function hasUseClientDirective(program: any) {
  return program.body.some((statement: any) => {
    return statement.type === "ExpressionStatement" && statement.expression?.value === "use client";
  });
}

function walkAst(node: any, visit: (node: any) => void) {
  if (!node || typeof node !== "object") {
    return;
  }

  visit(node);

  const keys = visitorKeys[node.type] ?? [];

  for (const key of keys) {
    const child = node[key];

    if (Array.isArray(child)) {
      for (const item of child) {
        walkAst(item, visit);
      }

      continue;
    }

    walkAst(child, visit);
  }
}

function getReactHookAliases(program: any) {
  const aliases = new Set<string>();
  const namespaceAliases = new Set<string>();

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source?.value !== "react") {
      continue;
    }

    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === "ImportSpecifier" && reactHooks.has(specifier.imported?.name)) {
        aliases.add(specifier.local.name);
      }

      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaceAliases.add(specifier.local.name);
      }
    }
  }

  return { aliases, namespaceAliases };
}

function isClientModule(filePath: string) {
  const { program } = parseModule(filePath);

  if (hasUseClientDirective(program)) {
    return true;
  }

  const { aliases, namespaceAliases } = getReactHookAliases(program);
  let client = false;

  walkAst(program, (node) => {
    if (client) {
      return;
    }

    if (node.type === "CallExpression") {
      if (node.callee?.type === "Identifier" && aliases.has(node.callee.name)) {
        client = true;
        return;
      }

      if (
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        namespaceAliases.has(node.callee.object.name) &&
        node.callee.property?.type === "Identifier" &&
        reactHooks.has(node.callee.property.name)
      ) {
        client = true;
        return;
      }
    }

    if (
      node.type === "JSXAttribute" &&
      node.name?.type === "JSXIdentifier" &&
      /^on[A-Z]/.test(node.name.name)
    ) {
      client = true;
      return;
    }

    if (node.type === "Identifier" && browserGlobals.has(node.name)) {
      client = true;
    }
  });

  return client;
}

function parseImportedNames(importClause: string) {
  const names = new Set<string>();
  const defaultMatch = importClause.match(/^\s*([A-Za-z_$][\w$]*)/);
  const namedMatch = importClause.match(/\{([^}]+)\}/);

  if (defaultMatch) {
    names.add("default");
  }

  if (namedMatch) {
    for (const part of namedMatch[1].split(",")) {
      const [name] = part.trim().split(/\s+as\s+/);

      if (name) {
        names.add(name.trim());
      }
    }
  }

  return [...names];
}

function createIslandProxy(root: string, sourcePath: string, exportNames: string[]) {
  const tmpDir = join(root, ".meiden", "server");
  mkdirSync(tmpDir, { recursive: true });

  const source = relative(root, sourcePath).replaceAll("\\", "/");
  const uniqueExports = [...new Set(exportNames.length > 0 ? exportNames : ["default"])];

  const content = `import React from "react";
${uniqueExports.map(exportName => {
  const functionName = exportName === "default" ? "MeidenDefaultIsland" : exportName;
  const declaration = `function ${functionName}(props = {}) {
  return React.createElement("div", {
    "data-meiden-island": "${source}",
    "data-meiden-export": "${exportName}",
    "data-meiden-props": encodeURIComponent(JSON.stringify(props ?? {})),
  });
}`;
  if (exportName === "default") {
    return `${declaration}\nexport default ${functionName};`;
  }
  return `export ${declaration}`;
}).join("\n")}
`;
  const proxyPath = join(tmpDir, `island-${hash(`${source}:${uniqueExports.join(",")}:${content}`)}.ts`);

  writeFileIfChanged(proxyPath, content);
  return proxyPath;
}

function createServerModule(root: string, filePath: string) {
  const tmpDir = join(root, ".meiden", "server");
  mkdirSync(tmpDir, { recursive: true });

  const realPath = toPath(filePath);
  const source = readFileSync(realPath, "utf8");
  const transformed = source.replace(
    /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g,
    (statement, importClause: string, specifier: string) => {
      const resolvedImport = resolveImport(realPath, specifier);

      if (!resolvedImport) {
        return statement;
      }

      if (isClientModule(resolvedImport)) {
        const proxyPath = createIslandProxy(root, resolvedImport, parseImportedNames(importClause));
        return statement.replace(specifier, proxyPath);
      }

      return statement.replace(specifier, resolvedImport);
    },
  );
  const result = `import React from "react";\n${transformed}`;
  const serverPath = join(tmpDir, `route-${hash(`${filePath}:${result}`)}.tsx`);

  writeFileIfChanged(serverPath, result);
  return serverPath;
}

async function loadConfig(root: string): Promise<MeidenConfig> {
  for (const extension of configExtensions) {
    const candidate = join(root, `meiden.config${extension}`);

    if (existsSync(candidate)) {
      const configModule = await import(pathToFileURL(candidate).href);
      return configModule.default ?? configModule;
    }
  }

  return {};
}

function resolveAppDir(root: string, config: MeidenConfig) {
  return resolve(root, config.appDir ?? config.srcDir ?? "src/app");
}

function toRoutePath(appDir: string, filePath: string) {
  const relativePath = filePath.slice(appDir.length + 1);
  const routeDir = relativePath.replace(routeFilePattern, "");

  if (!routeDir) {
    return "/";
  }

  return `/${routeDir}`;
}

function scanAppRoutes(appDir: string) {
  const routes: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (routeFilePattern.test(fullPath)) {
        routes.push(fullPath);
      }
    }
  }

  walk(appDir);
  return routes;
}

async function loadLegacyModules(root: string): Promise<AppModules> {
  const srcDir = join(root, "src");
  const layoutModule = await import(resolveAppModule(srcDir, "layout"));
  const indexModule = await import(resolveAppModule(srcDir, "index"));

  if (!layoutModule.default || !indexModule.default) {
    throw new Error("Meiden apps must export default components from src/layout and src/index.");
  }

  return {
    RootLayout: layoutModule.default,
    routes: [{ path: "/", Page: indexModule.default }],
  };
}

async function loadAppModules(root: string, config: MeidenConfig): Promise<AppModules> {
  const appDir = resolveAppDir(root, config);

  if (!existsSync(appDir)) {
    return loadLegacyModules(root);
  }

  const layoutModule = await import(pathToFileURL(createServerModule(root, resolveAppModule(appDir, "layout"))).href);
  const routeFiles = scanAppRoutes(appDir);

  if (!layoutModule.default || routeFiles.length === 0) {
    throw new Error("Meiden app router projects must export src/app/layout and at least one page.");
  }

  const routes = await Promise.all(
    routeFiles.map(async (filePath) => {
      const pageModule = await import(pathToFileURL(createServerModule(root, filePath)).href);

      if (!pageModule.default) {
        throw new Error(`Meiden page routes must export a default component: ${filePath}`);
      }

      return {
        path: toRoutePath(appDir, filePath),
        Page: pageModule.default,
        filePath,
      };
    }),
  );

  return {
    RootLayout: layoutModule.default,
    routes,
  };
}

export async function renderReact(root: string, element: unknown, renderer?: (element: any) => string) {
  if (typeof element === "string") {
    return injectIslandRuntime(`<!DOCTYPE html>${element}`, "/_meiden/islands/runtime.js");
  }

  let renderToStaticMarkup = renderer;

  if (!renderToStaticMarkup) {
    const requireFromApp = createRequire(join(root, "package.json"));
    const reactDomServerUrl = pathToFileURL(requireFromApp.resolve("react-dom/server")).href;
    const mod = await import(reactDomServerUrl);
    renderToStaticMarkup = mod.renderToStaticMarkup;
  }

  if (!renderToStaticMarkup) {
    throw new Error("Could not find renderToStaticMarkup");
  }

  return injectIslandRuntime(`<!DOCTYPE html>${renderToStaticMarkup(element)}`, "/_meiden/islands/runtime.js");
}

function createIslandRuntime(manifest?: Record<string, string>) {
  const manifestSource = JSON.stringify(manifest ?? {});

  return `
const manifest = ${manifestSource};
const islands = document.querySelectorAll("[data-meiden-island]");

for (const island of islands) {
  const source = island.getAttribute("data-meiden-island");
  const exportName = island.getAttribute("data-meiden-export") || "default";
  const encodedProps = island.getAttribute("data-meiden-props") || "%7B%7D";
  const props = JSON.parse(decodeURIComponent(encodedProps));
  const key = source + "#" + exportName;
  const moduleUrl = manifest[key] || "/_meiden/islands/" + encodeURIComponent(source) + "?name=" + encodeURIComponent(exportName);
  const mod = await import(moduleUrl);

  await mod.default(island, props);
}
`.trim();
}

async function buildIslandBundle(
  root: string,
  source: string,
  exportName: string,
  options: { minify?: boolean; development?: boolean } = {},
) {
  const islandPath = resolve(root, source);

  if (!islandPath.startsWith(`${root}/`) || !existsSync(islandPath)) {
    throw new Error(`Island not found: ${source}`);
  }

  const tmpDir = join(root, ".meiden", "islands");
  mkdirSync(tmpDir, { recursive: true });
  const reactTranspiler = new Bun.Transpiler({
    loader: "tsx",
    target: "browser",
    autoImportJSX: true,
    tsconfig: {
      compilerOptions: {
        jsx: "react-jsxdev",
        jsxImportSource: "react",
      },
    },
  });
  const tsconfigPath = join(tmpDir, "tsconfig.react.json");

  writeFileIfChanged(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "react",
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ESNext",
        },
      },
      null,
      2,
    ),
  );

  const compiledIslandContent = await reactTranspiler.transform(await Bun.file(islandPath).text(), "tsx");
  const compiledIslandPath = join(tmpDir, `source-${hash(`${source}:${compiledIslandContent}`)}.js`);
  const compiledIslandImportPath = relative(tmpDir, compiledIslandPath).replaceAll("\\", "/");
  const compiledIslandSpecifier = compiledIslandImportPath.startsWith(".")
    ? compiledIslandImportPath
    : `./${compiledIslandImportPath}`;

  writeFileIfChanged(compiledIslandPath, compiledIslandContent);

  const entryContent = `
/** @jsxImportSource react */
import React from "react";
import { hydrateRoot } from "react-dom/client";
import * as islandModule from ${JSON.stringify(compiledIslandSpecifier)};

const Component = islandModule[${JSON.stringify(exportName)}];

export default function hydrate(target, props) {
  hydrateRoot(target, React.createElement(Component, props));
}
`;
  const entryPath = join(tmpDir, `island-${hash(`${source}:${exportName}:${entryContent}`)}.tsx`);

  writeFileIfChanged(entryPath, entryContent);

  const build = await Bun.build({
    entrypoints: [entryPath],
    target: "browser",
    format: "esm",
    tsconfig: tsconfigPath,
    jsx: {
      runtime: "automatic",
      importSource: "react",
      development: options.development ?? true,
    },
    minify: options.minify ?? false,
  });

  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n") || "Failed to build island");
  }

  return await build.outputs[0].text();
}

async function buildIslandModule(root: string, source: string, exportName: string) {
  try {
    return new Response(await buildIslandBundle(root, source, exportName), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build island";
    const status = message.startsWith("Island not found") ? 404 : 500;

    return new Response(message, { status });
  }
}

export function createLayoutWrapper(RootLayout: AppModules["RootLayout"]) {
  return function LayoutWrapper({ Page }: LayoutWrapperProps) {
    return <RootLayout><Page /></RootLayout>;
  };
}

async function renderRoute(root: string, LayoutWrapper: Component<LayoutWrapperProps>, route: AppRoute) {
  return renderReact(root, <LayoutWrapper Page={route.Page} />);
}

function getIslands(html: string) {
  const islands = new Map<string, IslandReference>();
  const pattern =
    /<div\s+[^>]*data-meiden-island="([^"]+)"[^>]*data-meiden-export="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const source = match[1];
    const exportName = match[2] || "default";
    islands.set(`${source}#${exportName}`, {
      source,
      exportName,
    });
  }

  return [...islands.values()];
}

function routeOutputPath(outDir: string, routePath: string) {
  if (routePath === "/") {
    return join(outDir, "index.html");
  }

  return join(outDir, routePath.replace(/^\/+/, ""), "index.html");
}

function copyPublicDir(from: string, to: string) {
  if (!existsSync(from)) {
    return;
  }

  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    const sourcePath = join(from, entry);
    const targetPath = join(to, entry);
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      copyPublicDir(sourcePath, targetPath);
      continue;
    }

    mkdirSync(resolve(targetPath, ".."), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

export async function buildApp({
  root,
  outDir = "dist",
  minify = true,
}: BuildOptions): Promise<BuildResult> {
  const projectRoot = resolve(root);
  const outputRoot = resolve(projectRoot, outDir);
  const config = await loadConfig(projectRoot);
  const { RootLayout, routes } = await loadAppModules(projectRoot, config);
  const LayoutWrapper = createLayoutWrapper(RootLayout);
  const rendered = new Map<AppRoute, string>();
  const islands = new Map<string, IslandReference>();
  const assets: BuildResult["assets"] = [];

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  copyPublicDir(join(projectRoot, "public"), outputRoot);

  for (const route of routes) {
    const html = await renderRoute(projectRoot, LayoutWrapper, route);
    rendered.set(route, html);

    for (const island of getIslands(html)) {
      islands.set(`${island.source}#${island.exportName}`, island);
    }
  }

  const manifest: Record<string, string> = {};
  const islandList = [...islands.values()];

  await Promise.all(
    islandList.map(async (island) => {
      const key = `${island.source}#${island.exportName}`;
      const bundle = await buildIslandBundle(projectRoot, island.source, island.exportName, {
        minify,
        development: false,
      });
      const fileName = `${hash(`${key}:${bundle}`)}.js`;
      const publicPath = `/_meiden/islands/${fileName}`;
      const outputPath = join(outputRoot, "_meiden", "islands", fileName);

      mkdirSync(resolve(outputPath, ".."), { recursive: true });
      writeFileIfChanged(outputPath, bundle);
      manifest[key] = publicPath;

      assets.push({
        name: `/_meiden/islands/${fileName}`,
        size: Buffer.byteLength(bundle),
        type: "island",
      });
    }),
  );

  const runtimeContent = createIslandRuntime(manifest);
  const runtimePath = join(outputRoot, "_meiden", "islands", "runtime.js");
  mkdirSync(resolve(runtimePath, ".."), { recursive: true });
  writeFileIfChanged(runtimePath, runtimeContent);
  assets.push({
    name: "/_meiden/islands/runtime.js",
    size: Buffer.byteLength(runtimeContent),
    type: "runtime",
  });

  for (const [route, html] of rendered) {
    const outputPath = routeOutputPath(outputRoot, route.path);

    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileIfChanged(outputPath, html);

    assets.push({
      name: route.path === "/" ? "/index.html" : `${route.path}/index.html`,
      size: Buffer.byteLength(html),
      type: "route",
    });
  }

  await buildServer(projectRoot, outputRoot, routes, RootLayout, minify);

  return {
    outDir: outputRoot,
    routes: routes.length,
    islands: islands.size,
    assets: assets.sort((a, b) => b.size - a.size),
  };
}

async function buildServer(
  root: string,
  outDir: string,
  routes: AppRoute[],
  RootLayout: Component,
  minify: boolean,
) {
  const tmpDir = join(root, ".meiden", "server");
  mkdirSync(tmpDir, { recursive: true });

  const entryPath = join(tmpDir, "production-server.tsx");
  
  // Transform all routes and layout to use island proxies
  const config = await loadConfig(root);
  const layoutFilePath = toPath(resolveAppModule(resolveAppDir(root, config), "layout"));
  const transformedLayoutPath = createServerModule(root, layoutFilePath);
  
  const routeImports: string[] = [];
  const routesArrayItems: string[] = [];
  
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const transformedPath = createServerModule(root, r.filePath);
    routeImports.push(`import Page${i} from "${transformedPath}";`);
    routesArrayItems.push(`{ path: "${r.path}", Page: Page${i} }`);
  }

  const requireFromApp = createRequire(join(root, "package.json"));
  const reactDomServerPath = requireFromApp.resolve("react-dom/server");

  // Write a temporary tsconfig.json to ensure React JSX is used
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      allowJs: true,
      strict: true,
      skipLibCheck: true,
    }
  };
  await Bun.write(join(tmpDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

  const entryContent = `
import { createProductionApp } from "../../../src/runtime/server";
import { injectIslandRuntime } from "../../../src/runtime/utils";
import { renderToStaticMarkup } from "${reactDomServerPath.replaceAll("\\", "/")}";
import RootLayout from "${transformedLayoutPath}";
${routeImports.join("\n")}

const routes = [${routesArrayItems.join(", ")}];
const distRoot = import.meta.dir;

const app = createProductionApp({ 
  routes, 
  RootLayout, 
  distRoot,
  render: renderToStaticMarkup,
  port: Number(process.env.PORT) || 3000 
});

app.listen(Number(process.env.PORT) || 3000);

console.log("");
console.log("\\x1b[36mMeiden\\x1b[0m \\x1b[32mproduction server ready\\x1b[0m");
console.log("");
console.log("  \\x1b[2mLocal:\\x1b[0m   http://localhost:" + (process.env.PORT || 3000));
console.log("");
`;

  writeFileIfChanged(entryPath, entryContent);

  const reactPath = requireFromApp.resolve("react");
  const reactDomPath = requireFromApp.resolve("react-dom");

  const build = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    minify: true,
    outdir: outDir,
    naming: "server.js",
  });

  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n") || "Failed to build production server");
  }
}

export function getContentType(filePath: string) {
  return contentTypes[extname(filePath)] ?? "application/octet-stream";
}

export function resolveBuiltFile(distRoot: string, requestPath: string) {
  const pathname = decodeURIComponent(new URL(requestPath, "http://meiden.local").pathname);
  const cleanPath = pathname.replace(/^\/+/, "");
  const candidates = [
    cleanPath ? join(distRoot, cleanPath) : join(distRoot, "index.html"),
    join(distRoot, cleanPath, "index.html"),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);

    if (!resolved.startsWith(`${distRoot}/`) && resolved !== distRoot) {
      continue;
    }

    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return resolved;
    }
  }

  return undefined;
}

export function startProductionServer({ root, outDir = "dist", port = 3000 }: ProductionServerOptions) {
  const projectRoot = resolve(root);
  const distRoot = resolve(projectRoot, outDir);

  if (!existsSync(distRoot)) {
    throw new Error(`Build output not found: ${distRoot}. Run meiden build first.`);
  }

  return Bun.serve({
    port,
    fetch(request) {
      const startedAt = performance.now();
      const filePath = resolveBuiltFile(distRoot, request.url);

      if (!filePath) {
        logRequest(request.method, new URL(request.url).pathname, 404, startedAt);
        return new Response("Not found", { status: 404 });
      }

      logRequest(request.method, new URL(request.url).pathname, 200, startedAt);

      return new Response(Bun.file(filePath), {
        headers: {
          "content-type": getContentType(filePath),
        },
      });
    },
  });
}

export async function startServer({ root, port = 3000 }: StartServerOptions) {
  const projectRoot = resolve(root);
  const config = await loadConfig(projectRoot);
  const { RootLayout, routes } = await loadAppModules(projectRoot, config);
  const LayoutWrapper = createLayoutWrapper(RootLayout);

  const app = new Elysia().use(html());

  app.get("/_meiden/islands/runtime.js", () => new Response(createIslandRuntime(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
    },
  }));

  app.get("/_meiden/islands/:source", ({ params, query }) => {
    return buildIslandModule(projectRoot, decodeURIComponent(params.source), String(query.name ?? "default"));
  });

  for (const route of routes) {
    app.get(route.path, async ({ request, set }) => {
      const startedAt = performance.now();
      const page = <LayoutWrapper Page={route.Page} />;

      try {
        const html = await renderReact(projectRoot, page);
        const status = Number(set.status) || 200;
        logRequest(request.method, route.path, status, startedAt);

        return html;
      } catch {
        const status = Number(set.status) || 200;
        logRequest(request.method, route.path, status, startedAt);

        return page;
      }
    });
  }

  app.listen(port);

  return app;
}
