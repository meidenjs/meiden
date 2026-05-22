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
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  injectIslandRuntime,
  getContentType,
  getContentTypeMapForServer,
  colors,
  color,
  statusColor,
  formatDuration,
  logRequest,
} from "../runtime/utils";

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
    type: "route" | "island" | "runtime" | "shared";
  }>;
}

interface MeidenConfig {
  appDir?: string;
  srcDir?: string;
}

interface AppModules {
  RootLayout: Component<{ children: unknown }>;
  routes: RouteManifestEntry[];
  /** Nested layout components indexed by their file path */
  nestedLayouts: Map<string, Component<{ children: unknown }>>;
}

interface AppRoute {
  path: string;
  Page: Component;
  filePath: string;
}

// ─── Route Manifest Types ───────────────────────────────────────────

/**
 * The kind of dynamic segment in a route path.
 * - "static": no dynamic segment (e.g. /about)
 * - "param": single dynamic segment (e.g. /blog/[slug])
 * - "wildcard": catch-all segment (e.g. /docs/[...path])
 */
type SegmentKind = "static" | "param" | "wildcard";

type RouteKind = "page" | "api";

/**
 * A single parsed segment of a route pattern.
 * For `/blog/[slug]` this produces two segments:
 *   { raw: "blog", kind: "static" }
 *   { raw: "[slug]", kind: "param", name: "slug" }
 */
interface RouteSegment {
  /** The raw directory name from the file path (e.g. "[slug]", "blog") */
  raw: string;
  /** Whether this segment is static, a dynamic param, or a wildcard catch-all */
  kind: SegmentKind;
  /** The param name for dynamic/wildcard segments (e.g. "slug", "path") */
  name?: string;
}

/**
 * An entry in the route manifest — the core data structure that replaces
 * the old scan-and-register approach. Every page in the app directory
 * produces one RouteManifestEntry.
 *
 * The manifest is the single source of truth for:
 * - Route matching (regex pattern + params extraction)
 * - Page rendering (filePath → import → Page component)
 * - Hot reload (filePath → dependency graph)
 * - Future: nested layouts, API routes, runtime route lifecycle
 *
 * Example for `app/blog/[slug]/page.tsx`:
 *   {
 *     kind: "page",
 *     path: "/blog/[slug]",
 *     pattern: /^\/blog\/([^/]+)$/,
 *     segments: [
 *       { raw: "blog", kind: "static" },
 *       { raw: "[slug]", kind: "param", name: "slug" },
 *     ],
 *     params: ["slug"],
 *     filePath: "/abs/path/to/app/blog/[slug]/page.tsx",
 *   }
 */
interface RouteManifestEntry {
  /** "page" for page routes, "api" for API routes */
  kind: RouteKind;
  /** The route pattern with bracket notation (e.g. "/blog/[slug]") */
  path: string;
  /** Compiled regex for matching URL paths and extracting params */
  pattern: RegExp;
  /** Parsed segments of the route path */
  segments: RouteSegment[];
  /** Ordered list of dynamic param names (e.g. ["slug"]) */
  params: string[];
  /** Absolute file path to the page module */
  filePath: string;
  /** Whether this route has any dynamic segments */
  isDynamic: boolean;
  /** Loaded page component (undefined until loaded, only for kind: "page") */
  Page?: Component;
  /**
   * Optional data loader function for page routes.
   * If a page module exports a `load` function, it is called during SSR
   * with the route params and the result is passed as a `data` prop to
   * the page component. This enables server-side data fetching.
   * Only runs on the server — the load function is never sent to the client.
   */
  load?: (ctx: { params: Record<string, string> }) => Promise<unknown>;
  /**
   * Loaded API route handlers (only for kind: "api").
   * Maps HTTP method names ("GET", "POST", "PUT", "DELETE", "PATCH",
   * "HEAD", "OPTIONS") to handler functions.
   * If a request uses a method not in this map, the server returns 405.
   */
  handlers?: Record<string, (ctx: ApiRouteContext) => any | Promise<any>>;
  /**
   * Ordered list of layout file paths from root to nearest route directory.
   * For a page at app/blog/[slug]/page.tsx, this would be:
   *   ["/abs/app/blog/[slug]/layout.tsx", "/abs/app/blog/layout.tsx"]
   * (nearest first, root app/layout.tsx is NOT included — it's always
   * the outermost wrapper and stored separately in RouteStore.RootLayout)
   */
  layouts: string[];
}

interface LayoutWrapperProps {
  Page: Component;
  params: Record<string, string>;
  /** Data returned by the page's optional load() function */
  data: unknown;
}

interface IslandReference {
  source: string;
  exportName: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const moduleExtensions = [".tsx", ".ts", ".jsx", ".js"];
const configExtensions = [".ts", ".js", ".mjs", ".mts", ".cjs"];
const routeFilePattern = /(^|\/)page\.(tsx|ts|jsx|js)$/;
const apiRouteFilePattern = /(^|\/)route\.(tsx|ts|jsx|js)$/;
const layoutFilePattern = /(^|\/)layout\.(tsx|ts|jsx|js)$/;

/** HTTP methods that API routes can export as handlers */
const API_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
type ApiMethod = typeof API_METHODS[number];

/**
 * Context object passed to API route handler functions.
 * Provides access to the request, URL params, and utility methods
 * for building responses.
 */
interface ApiRouteContext {
  /** The original Request object */
  request: Request;
  /** URL params extracted from dynamic segments (e.g. { slug: "hello" }) */
  params: Record<string, string>;
}

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

// ─── Utility Functions ──────────────────────────────────────────────

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

/**
 * Escape a string value for safe embedding inside a JavaScript template
 * literal or double-quoted string in generated code.
 */
function escapeJsString(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$");
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

// ─── AST Parsing & Analysis ────────────────────────────────────────

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

/**
 * Walk the AST with parent tracking. The visitor receives (node, parent, key)
 * so it can make context-aware decisions about identifier usage.
 */
function walkAstWithParent(
  node: any,
  parent: any,
  key: string | null,
  visit: (node: any, parent: any, key: string | null) => void,
) {
  if (!node || typeof node !== "object") {
    return;
  }

  visit(node, parent, key);

  const keys = visitorKeys[node.type] ?? [];

  for (const childKey of keys) {
    const child = node[childKey];

    if (Array.isArray(child)) {
      for (const item of child) {
        walkAstWithParent(item, node, childKey, visit);
      }
      continue;
    }

    walkAstWithParent(child, node, childKey, visit);
  }
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

/**
 * Determine if a module is a client module by checking for:
 * 1. "use client" directive
 * 2. React hook usage (call expressions)
 * 3. JSX event handlers (onClick, etc.)
 * 4. Browser global references (context-aware: excludes typeof guards,
 *    variable declarations, and property keys)
 */
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

    // React hook call: useState(...), React.useState(...)
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

    // JSX event handler: onClick={...}
    if (
      node.type === "JSXAttribute" &&
      node.name?.type === "JSXIdentifier" &&
      /^on[A-Z]/.test(node.name.name)
    ) {
      client = true;
      return;
    }
  });

  // Browser global check — context-aware to avoid false positives.
  // We use parent-tracking to exclude:
  //   - `typeof window !== "undefined"` (SSR guard pattern)
  //   - Variable declarations like `const window = ...`
  //   - Property keys like `obj.window`
  //   - Import specifiers
  if (!client) {
    const definingNames = new Set<string>();

    // First pass: collect all names that are defined (declared) in this module
    walkAst(program, (node) => {
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
        definingNames.add(node.id.name);
      }
      if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
        definingNames.add(node.id.name);
      }
      if (node.type === "ImportSpecifier" && node.local?.type === "Identifier") {
        definingNames.add(node.local.name);
      }
      if (node.type === "ImportDefaultSpecifier" && node.local?.type === "Identifier") {
        definingNames.add(node.local.name);
      }
      if (node.type === "ImportNamespaceSpecifier" && node.local?.type === "Identifier") {
        definingNames.add(node.local.name);
      }
      // Function parameters
      if (node.type === "Identifier" && node.typeAnnotation) {
        // Identifier with type annotation in parameter position
      }
    });

    // Collect function parameter names
    walkAstWithParent(program, null, null, (node, parent, parentKey) => {
      if (
        node.type === "Identifier" &&
        (parentKey === "params" || parentKey === "rest")
      ) {
        definingNames.add(node.name);
      }
    });

    // Second pass: check browser global references with context
    walkAstWithParent(program, null, null, (node, parent, parentKey) => {
      if (client) return;

      if (node.type !== "Identifier" || !browserGlobals.has(node.name)) {
        return;
      }

      // Skip if this identifier is being defined (shadowed variable)
      if (definingNames.has(node.name)) {
        return;
      }

      // Skip if inside `typeof window` — this is an SSR guard, not a browser dependency
      if (
        parent?.type === "UnaryExpression" &&
        parent.operator === "typeof"
      ) {
        return;
      }

      // Skip property keys: `obj.window` — the Identifier is the property, not the object
      // In MemberExpression, the property is in .property, not .object
      if (parent?.type === "MemberExpression" && parentKey === "property" && !parent.computed) {
        return;
      }

      // Skip if it's a property key in an object literal: `{ window: 123 }`
      if (parent?.type === "Property" && parentKey === "key" && !parent.computed) {
        return;
      }

      // Skip if it's a shorthand property value that shadows: `{ window }` where window is a local variable
      if (parent?.type === "Property" && parent.shorthand) {
        // This could be a destructuring pattern — ambiguous. Only flag if not in defining names.
        if (definingNames.has(node.name)) {
          return;
        }
      }

      // Skip export names: `export { window }`
      if (parent?.type === "ExportSpecifier") {
        return;
      }

      // If we get here, it's a genuine browser global reference
      client = true;
    });
  }

  return client;
}

// ─── Import Analysis (AST-based) ───────────────────────────────────

interface ImportLocalBinding {
  /** The local variable name in the importing module */
  localName: string;
  /** The type of import: "default", "named", or "namespace" */
  kind: "default" | "named" | "namespace";
}

interface ImportInfo {
  /** The full original import statement text */
  statement: string;
  /** Start offset of the import statement in the source */
  start: number;
  /** End offset of the import statement in the source */
  end: number;
  /** The module specifier (e.g., "./Counter") */
  specifier: string;
  /** Parsed export names imported from this module. "*" means namespace import. */
  importedNames: string[];
  /** Whether this is a namespace import (import * as X) */
  isNamespace: boolean;
  /** The local binding name for namespace imports (e.g., "Counter" in `import * as Counter`) */
  namespaceLocal?: string;
  /** Local binding names for each import specifier */
  localBindings: ImportLocalBinding[];
}

/**
 * Parse all import declarations from a source file using the AST.
 * This replaces the regex-based approach and correctly handles:
 * - Namespace imports: `import * as React from "react"`
 * - Side-effect imports: `import "./styles.css"`
 * - Multi-line imports
 * - Import comments
 */
function parseImports(filePath: string): ImportInfo[] {
  const source = readFileSync(filePath, "utf8");
  const { program } = parseModule(filePath);
  const imports: ImportInfo[] = [];

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }

    const specifier = statement.source.value;
    const importedNames: string[] = [];

    let isNamespace = false;
    let namespaceLocal: string | undefined;

    for (const spec of statement.specifiers ?? []) {
      if (spec.type === "ImportDefaultSpecifier") {
        importedNames.push("default");
      } else if (spec.type === "ImportSpecifier") {
        const imported = spec.imported as any;
        importedNames.push(imported?.name ?? imported?.value ?? spec.local.name);
      } else if (spec.type === "ImportNamespaceSpecifier") {
        importedNames.push("*");
        isNamespace = true;
        namespaceLocal = spec.local?.name;
      }
    }

    const localBindings: ImportLocalBinding[] = [];
    for (const spec of statement.specifiers ?? []) {
      if (spec.type === "ImportDefaultSpecifier") {
        localBindings.push({ localName: spec.local?.name ?? "default", kind: "default" });
      } else if (spec.type === "ImportSpecifier") {
        localBindings.push({ localName: spec.local?.name ?? "", kind: "named" });
      } else if (spec.type === "ImportNamespaceSpecifier") {
        localBindings.push({ localName: spec.local?.name ?? "", kind: "namespace" });
      }
    }

    imports.push({
      statement: source.slice(statement.start, statement.end),
      start: statement.start,
      end: statement.end,
      specifier,
      importedNames,
      isNamespace,
      namespaceLocal,
      localBindings,
    });
  }

  return imports;
}

/**
 * Extract the named exports from a module file using the AST.
 * Used when a namespace import (`import * as X from "..."`) references
 * a client module — we need to know the actual export names so the
 * proxy can create valid JS functions for each one instead of the
 * invalid `function *()`.
 */
function getModuleExportNames(filePath: string): string[] {
  const { program } = parseModule(filePath);
  const exports: string[] = [];

  for (const statement of program.body) {
    // export default function ...
    if (statement.type === "ExportDefaultDeclaration") {
      exports.push("default");
    }

    // export function Foo() {}
    // export const bar = ...
    // export { foo, bar as baz }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration) {
        if (statement.declaration.type === "FunctionDeclaration" && statement.declaration.id?.type === "Identifier") {
          exports.push(statement.declaration.id.name);
        }
        if (statement.declaration.type === "ClassDeclaration" && statement.declaration.id?.type === "Identifier") {
          exports.push(statement.declaration.id.name);
        }
        if (statement.declaration.type === "VariableDeclaration") {
          for (const decl of statement.declaration.declarations ?? []) {
            if (decl.id?.type === "Identifier") {
              exports.push(decl.id.name);
            }
          }
        }
      }
      if (statement.specifiers) {
        for (const spec of statement.specifiers) {
          if (spec.type === "ExportSpecifier") {
            const exported = spec.exported as any;
            const name = exported?.name ?? exported?.value;
            if (name === "default") {
              exports.push("default");
            } else if (name) {
              exports.push(name);
            }
          }
        }
      }
    }
  }

  return [...new Set(exports)];
}

// ─── Island Proxy ──────────────────────────────────────────────────

/**
 * Create an island proxy that renders the real component on the server.
 *
 * Key improvements over the previous version:
 * - Uses top-level `await import()` with try/catch so that browser-only
 *   top-level code in island modules is caught at import time (fixes
 *   import-time failure fallback — Issue #2).
 * - Namespace imports (`import * as X from "..."`) are resolved to their
 *   actual export names so the generated proxy contains valid JS identifiers
 *   instead of the invalid `function *()`.
 * - String interpolation is properly escaped for safe embedding.
 * - Component functions remain synchronous so React's renderToString works.
 *
 * If the real component crashes during import, the error is caught by the
 * top-level try/catch and the island falls back to an empty placeholder.
 * If it crashes during rendering, the IslandErrorBoundary catches the error
 * within React's reconciliation and renders the placeholder instead.
 */
function createIslandProxy(root: string, sourcePath: string, exportNames: string[]) {
  const tmpDir = join(root, ".meiden", "server");
  mkdirSync(tmpDir, { recursive: true });

  // Transform the client component through createServerModule() to get a
  // content-hashed SSR copy. This recursively transforms all relative
  // imports (both client and non-client) so the entire dependency chain
  // is content-hashed. When any dependency of the island changes:
  //   1. Its server module gets a new hash
  //   2. The island's import specifier changes → island server module hash changes
  //   3. The proxy's import specifier changes → proxy hash changes
  //   4. The page's import specifier changes → page server module hash changes
  //   5. Bun loads fresh code all the way down
  //
  // Previously, the island proxy imported the client component via a stable
  // raw source path, so Bun's ESM cache returned stale code after edits.
  // An intermediate createIslandSourceModule() only hashed the island's own
  // source and rewrote relative imports to absolute paths — but nested
  // dependency changes didn't propagate because those absolute paths were
  // also stable. Using createServerModule() fixes both direct edits to the
  // island source AND edits to its nested dependencies.
  const hashedSourcePath = createServerModule(root, sourcePath);

  // If exportNames contains "*", resolve to actual module exports.
  // This handles namespace imports like `import * as Counter from "./Counter"`
  // where "*" would otherwise become an invalid function name.
  let resolvedExportNames = exportNames;
  if (exportNames.includes("*")) {
    const actualExports = getModuleExportNames(sourcePath);
    if (actualExports.length > 0) {
      // Replace "*" with the actual exports from the module
      resolvedExportNames = [
        ...exportNames.filter(n => n !== "*"),
        ...actualExports,
      ];
    } else {
      // Fallback: if we can't determine exports, assume default
      resolvedExportNames = exportNames.filter(n => n !== "*").concat(["default"]);
    }
  }

  const source = escapeJsString(relative(root, sourcePath).replaceAll("\\", "/"));
  const uniqueExports = [...new Set(resolvedExportNames.length > 0 ? resolvedExportNames : ["default"])];
  const absolutePath = escapeJsString(hashedSourcePath.replaceAll("\\", "/"));

  // Synchronous proxy functions that use the module loaded via top-level await.
  // If import failed, the function returns a placeholder div.
  const proxyFunctions = uniqueExports.map((rawExportName) => {
    const exportName = escapeJsString(rawExportName);
    const functionName = rawExportName === "default" ? "MeidenDefaultIsland" : rawExportName;
    const componentAccess = rawExportName === "default" ? `islandModule.default` : `islandModule[${JSON.stringify(escapeJsString(rawExportName))}]`;

    return `
function ${functionName}(props = {}) {
  const islandProps = encodeURIComponent(JSON.stringify(props ?? {}));
  const islandAttrs = {
    "data-meiden-island": "${source}",
    "data-meiden-export": "${exportName}",
    "data-meiden-props": islandProps,
  };

  if (islandLoadError) {
    return React.createElement("div", islandAttrs);
  }

  const Component = ${componentAccess};
  if (!Component) {
    console.error("[meiden] SSR: export \\"${exportName}\\" not found in island \\"${source}\\"");
    return React.createElement("div", islandAttrs);
  }

  return React.createElement(IslandErrorBoundary, {
    islandSource: "${source}",
    islandExport: "${exportName}",
    islandProps: islandProps,
    islandId: "${source}#${exportName}",
  }, React.createElement("div", islandAttrs, React.createElement(Component, props)));
}`;
  });

  const exports = uniqueExports.map((name) => {
    const functionName = name === "default" ? "MeidenDefaultIsland" : name;
    if (name === "default") {
      return `export default ${functionName};`;
    }
    return `export { ${functionName} };`;
  });

  // Use top-level await with try/catch to handle import-time failures.
  // If the island module has browser-only top-level code (e.g. accessing
  // `window`), the dynamic import will throw — but we catch it here,
  // so the proxy module still loads successfully and falls back to an
  // empty placeholder during rendering.
  const content = `import React from "react";

let islandModule = null;
let islandLoadError = null;

try {
  islandModule = await import("${absolutePath}");
} catch (error) {
  islandLoadError = error;
  console.error("[meiden] SSR import failed for island \\"${source}\\":", error);
}

/**
 * React Error Boundary for island rendering errors (best-effort).
 * React 18's server-side renderToString supports Error Boundaries, so
 * this can catch component-thrown errors during render in many cases.
 * However, this is not a guarantee — some errors (e.g. in lifecycle
 * methods, or errors that occur outside React's error handling) may
 * still propagate. The primary fallback is the import-time try/catch
 * above; this boundary is a secondary safety net for render errors.
 *
 * Import-time failures (top-level window access, etc.) are handled by
 * the top-level await try/catch above, not by this boundary.
 */
class IslandErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    console.error("[meiden] SSR render failed for island " + this.props.islandId + ":", error);
  }
  render() {
    if (this.state.hasError) {
      return React.createElement("div", {
        "data-meiden-island": this.props.islandSource,
        "data-meiden-export": this.props.islandExport,
        "data-meiden-props": this.props.islandProps,
      });
    }
    return this.props.children;
  }
}

${proxyFunctions.join("\n")}

${exports.join("\n")}
`;

  const proxyPath = join(tmpDir, `island-${hash(`${source}:${uniqueExports.join(",")}:${content}`)}.ts`);
  writeFileIfChanged(proxyPath, content);
  return proxyPath;
}

// ─── Server Module (AST-based import rewriting) ────────────────────

/**
 * Create a server-side version of a page module by rewriting client
 * component imports to use island proxies instead.
 *
 * Uses AST-based transformation instead of regex for reliability.
 * Correctly handles:
 * - Namespace imports (`import * as X from "..."`)
 * - Side-effect imports (`import "..."`)
 * - Multi-line imports
 * - Import comments
 */
/**
 * Dependency graph: maps a server module's source file path to the set of
 * source file paths that import it (directly or indirectly). Used by the
 * hot-reload watcher to find which page/layout modules need to be
 * re-imported when a component file changes.
 */
const dependencyGraph = new Map<string, Set<string>>();

/** Register that `importerPath` imports `dependencyPath`. */
function registerDependency(importerPath: string, dependencyPath: string) {
  if (!dependencyGraph.has(dependencyPath)) {
    dependencyGraph.set(dependencyPath, new Set());
  }
  dependencyGraph.get(dependencyPath)!.add(importerPath);
}

/**
 * Clear all dependency edges where `importerPath` is the importer.
 * Called before re-transforming a file during hot reload so that
 * stale edges (from imports that were removed) don't linger.
 */
function clearDependenciesOf(importerPath: string) {
  for (const dependents of dependencyGraph.values()) {
    dependents.delete(importerPath);
  }
}

/**
 * Find all source files that transitively depend on `sourcePath`.
 * Walks the dependency graph upward to find the root importers
 * (page/layout files). Returns a set of absolute file paths.
 */
function findDependents(sourcePath: string): Set<string> {
  const visited = new Set<string>();
  const result = new Set<string>();

  function walk(path: string) {
    if (visited.has(path)) return;
    visited.add(path);

    const dependents = dependencyGraph.get(path);
    if (dependents) {
      for (const dep of dependents) {
        result.add(dep);
        walk(dep);
      }
    }
  }

  walk(sourcePath);
  return result;
}

/**
 * Monotonically increasing counter incremented each time a top-level
 * `createServerModule` call begins. Used as a transform generation ID
 * in the deterministic cyclic path so that every HMR cascade produces
 * fresh paths for ALL files — even those whose own source didn't change.
 *
 * Why not just hash the source? Consider A → B → A (cycle):
 *   - Edit B only: A's source is unchanged → sourceHash is the same
 *   - But A's transformed output DID change (A imports B's new path)
 *   - Bun's ESM cache would return the old deterministic A module
 *   - With a generation ID, A's path changes on every HMR cascade
 *
 * The generation is scoped to a single transform cascade: all recursive
 * calls within the same top-level call share the same generation ID.
 */
let transformGeneration = 0;

/**
 * Create a server-side version of a module by rewriting imports.
 *
 * For page/layout files: rewrites client component imports to island proxies,
 * unresolvable imports to throwing Proxy stubs, and recursively transforms
 * non-client relative imports through `createServerModule` so that the
 * entire import chain is content-hashed. This creates a cascade: when a
 * component changes, its server module gets a new hash → the importing
 * page's specifier changes → the page's server module gets a new hash →
 * Bun's dynamic `import()` loads the fresh code instead of the cached version.
 *
 * For component/utility files: same logic applies — all relative imports
 * are recursively transformed, so deep dependency chains are fully tracked.
 *
 * Circular import guard: the `stack` set tracks files currently being
 * processed on the call stack. A path is added on entry and removed in a
 * `finally` block on exit, so only files that are ancestors in the current
 * recursion chain remain in the set. If a circular import is detected
 * (A → B → A), the function returns the in-progress server module path
 * instead of recursing, breaking the cycle safely. Shared dependencies
 * are not affected because they are removed from the stack once finished:
 *
 *     page → A → Shared   (Shared removed after A finishes)
 *     page → B → Shared   (Shared not in stack — processed normally)
 *
 * In-progress module map: the `inProgress` map tracks the generation-scoped
 * server module path for each file currently being transformed. When a
 * circular import is detected, the cyclic reference uses this path
 * instead of the raw source path. This ensures that even cyclic
 * references point to a Meiden-transformed module (with `import React`,
 * rewritten island proxies, etc.) rather than the unprocessed source.
 *
 * Generation-scoped versioning: the in-progress path includes a
 * transform generation ID (`route-${hash(realPath)}-${transformId}.tsx`).
 * This ensures the path changes for every HMR transform cascade, even
 * if a particular file's own source didn't change. Without this, a
 * file whose source was unchanged but whose transformed output changed
 * (due to a dependency being edited) would keep the same deterministic
 * path and Bun would return the cached (stale) module:
 *
 *     A → B → A (cycle)
 *     Edit B only: A's source unchanged, but A's transform DID change
 *     → transformGeneration increments → new deterministic path for A
 *     → Bun loads fresh module instead of cached one
 *
 * The transformed content is written to both:
 *   1. The generation-scoped path (for cyclic references — busts ESM cache)
 *   2. The content-hashed path (for HMR cache-busting on the outer module)
 * The content-hashed path is returned from the outermost call so the
 * HMR cascade continues to work correctly.
 */
function createServerModule(root: string, filePath: string, stack?: Set<string>, inProgress?: Map<string, string>, transformId?: number) {
  const tmpDir = join(root, ".meiden", "server");
  mkdirSync(tmpDir, { recursive: true });

  const realPath = toPath(filePath);

  // Circular import guard: if this file is already being processed
  // higher up the call stack, return its in-progress server module path.
  // This prevents infinite recursion when A imports B and B imports A.
  // Unlike returning the raw source path, the in-progress path points
  // to a Meiden-transformed module (with `import React`, rewritten
  // island proxies, etc.) that will be written once the outer transform
  // completes.
  //
  // The stack behaves like a recursion stack, not a global visited set:
  // paths are added on entry and removed in a `finally` block on exit.
  // This avoids false positives for shared dependencies (A → Shared,
  // B → Shared) where Shared would otherwise remain in the set after
  // A finishes and be incorrectly treated as circular when B imports it.
  if (!stack) {
    stack = new Set();
    // Top-level call: increment the transform generation so that all
    // deterministic cyclic paths in this cascade are fresh, even for
    // files whose own source didn't change.
    transformGeneration++;
  }
  if (!inProgress) inProgress = new Map();
  // Use the transform generation ID from the top-level call (or
  // fall back to the current counter value for safety).
  const generation = transformId ?? transformGeneration;
  if (stack.has(realPath)) {
    // Cycle detected — return the in-progress server module path
    // (or fall back to the raw source if not yet registered)
    return inProgress.get(realPath) ?? realPath;
  }
  stack.add(realPath);

  const source = readFileSync(realPath, "utf8");

  // Pre-compute a generation-scoped deterministic server module path
  // and register it in the in-progress map before recursing into imports.
  // This allows cyclic references to find a valid server module path
  // even though the content-hashed path isn't known yet.
  //
  // The path includes the transform generation ID so that every HMR
  // cascade produces fresh paths for ALL files, even those whose own
  // source didn't change but whose transformed output did (because a
  // dependency was edited). This prevents stale cyclic references:
  //
  //   A -> B -> A (cycle)
  //   Edit B only: A's source unchanged, but transformGeneration
  //   increments → A gets a new deterministic path → Bun loads
  //   fresh module instead of the cached one
  const deterministicPath = join(tmpDir, `route-${hash(realPath)}-${generation}.tsx`);
  inProgress.set(realPath, deterministicPath);

  try {
    const imports = parseImports(realPath);

    // Clear stale dependency edges for this file before re-registering.
    // This handles the case where a hot-reloaded file removed an import
    // — without clearing, the old edge would remain in the graph.
    clearDependenciesOf(realPath);

    // Build replacements from end to start so offsets stay valid
    const replacements: Array<{ start: number; end: number; text: string }> = [];

    for (const imp of imports) {
      const resolvedImport = resolveImport(realPath, imp.specifier);

      if (!resolvedImport) {
        // For relative imports that can't be resolved, generate lazy stub
        // bindings using Proxy that throw only when accessed (not at module
        // evaluation time). This prevents `await import(...)` from crashing
        // the dev server and gives a clear error message when the unresolved
        // binding is actually used at runtime.
        // Non-relative imports (node_modules, built-ins) are left as-is.
        if (imp.specifier.startsWith(".")) {
          // Side-effect imports (no bindings): just remove the statement
          if (imp.localBindings.length === 0) {
            replacements.push({ start: imp.start, end: imp.end, text: "" });
            continue;
          }

          const safeSpecifier = escapeJsString(imp.specifier);
          const safeFrom = escapeJsString(relative(root, realPath).replaceAll("\\", "/"));
          const errMsg = `[meiden] Cannot resolve import ${safeSpecifier} from ${safeFrom}`;

          // Generate a unique stub proxy variable for each binding.
          // Use imp.start (byte offset of the import in the source) to avoid
          // collisions when multiple broken imports exist in the same file.
          const stubDecl = imp.localBindings.map((binding, i) => {
            const stubVar = `__meiden_stub_${imp.start}_${i}`;
            const localName = binding.localName;

            // All stubs use a plain object target with toString/valueOf/
            // Symbol.toPrimitive methods that throw. This ensures that:
            //
            //   <div>{Missing}</div>  → React calls Missing.toString() → throw → 500
            //   <Missing />           → React sees typeof !== "function" → "Element type is invalid" → throw → 500
            //   Missing.someProp      → Proxy get trap → throw → 500
            //   Missing()             → TypeError: Missing is not a function → 500
            //
            // We deliberately do NOT use a function target because React SSR
            // skips functions rendered as JSX children (just warns, returns 200).
            // Using an object target forces React into the toString() path which
            // our throwing methods intercept.
            const throwTarget = `{\n  toString() { throw new Error("${errMsg}"); },\n  valueOf() { throw new Error("${errMsg}"); },\n  [Symbol.toPrimitive]() { throw new Error("${errMsg}"); },\n}`;

            return `const ${stubVar} = new Proxy(${throwTarget}, { get: () => { throw new Error("${errMsg}"); } });\nconst ${localName} = ${stubVar};`;
          }).join("\n");

          replacements.push({ start: imp.start, end: imp.end, text: stubDecl });
        }
        continue;
      }

      if (isClientModule(resolvedImport)) {
        // Register the dependency relationship so that the hot-reload
        // watcher can find which pages/layouts need re-importing when
        // this client component (island) changes. Without this edge in
        // the dependency graph, findDependents() returns empty for
        // island changes and the page is not re-imported.
        registerDependency(realPath, resolvedImport);
        const proxyPath = createIslandProxy(root, resolvedImport, imp.importedNames);
        // Replace just the specifier part of the import
        const newStatement = imp.statement.replace(imp.specifier, proxyPath);
        replacements.push({ start: imp.start, end: imp.end, text: newStatement });
      } else if (imp.specifier.startsWith(".")) {
        // Recursively transform relative non-client imports so that the
        // entire import chain is content-hashed. When a component changes,
        // its server module gets a new hash → the importing file's specifier
        // changes → its server module also gets a new hash → Bun's import()
        // loads fresh code instead of the cached version.
        //
        // Also register the dependency relationship so that the hot-reload
        // watcher can find which pages need re-importing when this component
        // changes.
        registerDependency(realPath, resolvedImport);
        const depServerPath = createServerModule(root, resolvedImport, stack, inProgress, generation);
        const newStatement = imp.statement.replace(imp.specifier, depServerPath);
        replacements.push({ start: imp.start, end: imp.end, text: newStatement });
      } else {
        // Non-relative imports (node_modules, built-ins): leave as-is
      }
    }

    // Apply replacements from end to start to preserve offsets
    let result = source;
    for (const rep of replacements.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, rep.start) + rep.text + result.slice(rep.end);
    }

    result = `import React from "react";\n${result}`;

    // Write the transformed content to the generation-scoped path.
    // This path is used by cyclic references (B → A when A → B → A),
    // so it must contain the fully transformed module — not the raw
    // source. Because the path includes the transform generation ID,
    // it changes on every HMR cascade, busting Bun's ESM module cache
    // for cyclic imports even when the file's own source didn't change.
    writeFileIfChanged(deterministicPath, result);

    // Also write to a content-hashed path for HMR cache-busting.
    // When a file changes, its content hash changes → new filename →
    // Bun's import() loads fresh code instead of the cached version.
    const serverPath = join(tmpDir, `route-${hash(`${filePath}:${result}`)}.tsx`);
    writeFileIfChanged(serverPath, result);
    return serverPath;
  } finally {
    stack.delete(realPath);
    inProgress.delete(realPath);
  }
}

// ─── Config Loading ────────────────────────────────────────────────

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

/**
 * Parse a single directory segment name into a RouteSegment.
 *
 * Handles three patterns:
 *   "blog"         → { raw: "blog", kind: "static" }
 *   "[slug]"       → { raw: "[slug]", kind: "param", name: "slug" }
 *   "[...path]"    → { raw: "[...path]", kind: "wildcard", name: "path" }
 *
 * The bracket notation follows Next.js App Router conventions:
 * - [param] matches a single path segment (no slashes)
 * - [...param] matches one or more path segments (required catch-all)
 *   Note: Next.js also has [[...param]] for optional catch-all, which
 *   Meiden does not currently support.
 */
function parseSegment(raw: string): RouteSegment {
  // Catch-all: [...param]
  const wildcardMatch = raw.match(/^\[\.\.\.(\w+)\]$/);
  if (wildcardMatch) {
    return { raw, kind: "wildcard", name: wildcardMatch[1] };
  }

  // Dynamic param: [param]
  const paramMatch = raw.match(/^\[(\w+)\]$/);
  if (paramMatch) {
    return { raw, kind: "param", name: paramMatch[1] };
  }

  // Static segment
  return { raw, kind: "static" };
}

/**
 * Build a route manifest entry from a page file path.
 *
 * This replaces the old `toRoutePath()` + separate `scanAppRoutes()` approach.
 * Instead of just producing a flat string path, it:
 *   1. Parses each directory segment into a RouteSegment
 *   2. Compiles a regex pattern for URL matching
 *   3. Extracts the ordered list of dynamic param names
 *   4. Stores the original path with bracket notation
 *
 * The compiled regex enables O(n) route matching where n is the number of
 * routes, with O(1) param extraction via capture groups. Static routes are
 * tried first (no regex needed), then dynamic routes in order of specificity:
 * more specific patterns (fewer wildcards, more static segments) are matched
 * before less specific ones.
 *
 * Example inputs → outputs:
 *   app/page.tsx              → path: "/", pattern: /^\/$/, params: []
 *   app/about/page.tsx        → path: "/about", pattern: /^\/about$/, params: []
 *   app/blog/[slug]/page.tsx  → path: "/blog/[slug]", pattern: /^\/blog\/([^/]+)$/, params: ["slug"]
 *   app/docs/[...path]/page.tsx → path: "/docs/[...path]", pattern: /^\/docs\/([^/]+(?:\/[^/]+)*)$/, params: ["path"]
 */
function buildRouteManifestEntry(appDir: string, filePath: string, kind: RouteKind): RouteManifestEntry {
  const filePattern = kind === "page" ? routeFilePattern : apiRouteFilePattern;
  const relativePath = filePath.slice(appDir.length + 1);
  const routeDir = relativePath.replace(filePattern, "");

  // Root page/route: app/page.tsx → "/" or app/route.ts → "/"
  // No nested layouts possible for the root
  if (!routeDir) {
    return {
      kind,
      path: "/",
      pattern: /^\/$/,
      segments: [],
      params: [],
      filePath,
      isDynamic: false,
      layouts: [],
    };
  }

  // Parse each directory segment
  const dirParts = routeDir.split("/");
  const segments = dirParts.map(parseSegment);

  // Build the path string with bracket notation
  const path = "/" + segments.map(s => s.raw).join("/");

  // Extract param names in order
  const params = segments.filter(s => s.kind !== "static").map(s => s.name!);

  // Build the regex pattern for URL matching
  let patternStr = "^";
  for (const seg of segments) {
    patternStr += "\\/";
    if (seg.kind === "static") {
      // Escape regex special characters in static segment names
      patternStr += seg.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (seg.kind === "param") {
      // [param] matches exactly one non-slash segment
      patternStr += "([^/]+)";
    } else if (seg.kind === "wildcard") {
      // [...param] matches one or more segments (including slashes).
      // This follows Next.js App Router convention where `[...param]`
      // requires at least one segment, while `[[...param]]` is the
      // optional catch-all. Meiden does not currently support the
      // optional `[[...param]]` syntax.
      patternStr += "([^/]+(?:\\/[^/]+)*)";
    }
  }
  patternStr += "$";
  const pattern = new RegExp(patternStr);

  const isDynamic = segments.some(s => s.kind !== "static");

  // Resolve the nested layout chain for this page.
  // Returns paths ordered from nearest (innermost) to outermost,
  // excluding the root app/layout.tsx which is always the outermost
  // wrapper and stored separately in RouteStore.RootLayout.
  const layouts = resolveLayoutChain(appDir, filePath);

  return {
    kind,
    path,
    pattern,
    segments,
    params,
    filePath,
    isDynamic,
    layouts,
  };
}

/**
 * Safely decode a URL-encoded param value. Returns the decoded string
 * on success, or null if the value contains malformed percent-encoding
 * (e.g. `%E0%A4%A` — incomplete UTF-8 sequence). Returning null signals
 * to matchRoute() that this URL should be treated as "no match" (→ 404),
 * which is safer than:
 *   - Letting decodeURIComponent throw (matchRoute is called before the
 *     SSR try/catch, so the error would escape normal handling)
 *   - Silently passing the raw encoded value through (page components
 *     would receive garbled data like "hello%20world" instead of "hello world")
 *   - Returning the raw value on failure (inconsistent — some params
 *     decoded, others not)
 */
function safeDecodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Match a URL pathname against the route manifest and return the
 * matching entry plus extracted params.
 *
 * Matching strategy:
 *   1. Try static routes first (exact string match, O(1) via Map lookup)
 *   2. Try dynamic routes in registration order
 *      (more specific patterns are registered first by buildRouteManifest)
 *
 * Returns { entry, params } on match, or undefined if no route matches.
 * The params object maps param names to their extracted values:
 *   - [slug] → { slug: "hello" }
 *   - [...path] → { path: "a/b/c" } (string with slashes, at least one segment required)
 */
function matchRoute(
  pathname: string,
  staticRoutes: Map<string, RouteManifestEntry>,
  dynamicRoutes: RouteManifestEntry[],
): { entry: RouteManifestEntry; params: Record<string, string> } | undefined {
  // Fast path: exact match for static routes
  const staticEntry = staticRoutes.get(pathname);
  if (staticEntry) {
    return { entry: staticEntry, params: {} };
  }

  // Try each dynamic route pattern
  for (const entry of dynamicRoutes) {
    const match = pathname.match(entry.pattern);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < entry.params.length; i++) {
        const paramName = entry.params[i];
        const captured = match[i + 1];
        // URL-decode the captured value so that page components
        // receive decoded params. For example, /blog/hello%20world
        // should produce { slug: "hello world" }, not "hello%20world".
        // The ?? "" is a safety fallback for unexpected edge cases.
        // Uses safeDecodeParam instead of raw decodeURIComponent so
        // that malformed percent-encoded URLs (e.g. /blog/%E0%A4%A)
        // don't throw an unhandled URIError. Since matchRoute() is
        // called before the SSR try/catch block, a raw
        // decodeURIComponent crash would escape the normal error
        // handling path. On decode failure we treat the route as
        // "no match" (return undefined) which results in a 404 —
        // this is safer than passing the raw encoded value through
        // or letting the error propagate.
        const decoded = captured ? safeDecodeParam(captured) : "";
        if (decoded === null) return undefined; // malformed encoding → no match
        params[paramName] = decoded;
      }
      return { entry, params };
    }
  }

  return undefined;
}

/**
 * Build the complete route manifest for the app directory.
 *
 * Scans all page.tsx files and returns a sorted array of RouteManifestEntry.
 * Static routes come first, followed by dynamic routes sorted by specificity:
 *   1. Routes with more static segments before routes with fewer
 *   2. Routes with params before routes with wildcards
 *   3. Alphabetical as tiebreaker
 *
 * This ordering ensures that more specific patterns are matched first
 * when trying dynamic routes sequentially. For example:
 *   /blog/archive  (static)  → matched before
 *   /blog/[slug]   (param)   → matched before
 *   /docs/[...path] (wildcard)
 */
function buildRouteManifest(appDir: string): RouteManifestEntry[] {
  const { pageFiles, apiFiles } = scanAppRoutes(appDir);
  const pageEntries = pageFiles.map(filePath => buildRouteManifestEntry(appDir, filePath, "page"));
  const apiEntries = apiFiles.map(filePath => buildRouteManifestEntry(appDir, filePath, "api"));
  const entries = [...pageEntries, ...apiEntries];

  // Sort: static routes first, then by specificity (more static segments first),
  // then params before wildcards, then alphabetically.
  // API routes take priority over page routes at the same path.
  entries.sort((a, b) => {
    // Static routes before dynamic routes
    if (!a.isDynamic && b.isDynamic) return -1;
    if (a.isDynamic && !b.isDynamic) return 1;

    // Both dynamic: count static segments (more specific first)
    const aStaticCount = a.segments.filter(s => s.kind === "static").length;
    const bStaticCount = b.segments.filter(s => s.kind === "static").length;
    if (aStaticCount !== bStaticCount) return bStaticCount - aStaticCount;

    // Params before wildcards
    const aWildcard = a.segments.some(s => s.kind === "wildcard");
    const bWildcard = b.segments.some(s => s.kind === "wildcard");
    if (aWildcard !== bWildcard) return aWildcard ? 1 : -1;

    // API routes take priority over page routes at the same path
    if (a.path === b.path && a.kind !== b.kind) {
      return a.kind === "api" ? -1 : 1;
    }

    // Alphabetical as tiebreaker
    return a.path.localeCompare(b.path);
  });

  return entries;
}

function scanAppRoutes(appDir: string): { pageFiles: string[]; apiFiles: string[] } {
  const pageFiles: string[] = [];
  const apiFiles: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (routeFilePattern.test(fullPath)) {
        pageFiles.push(fullPath);
      } else if (apiRouteFilePattern.test(fullPath)) {
        apiFiles.push(fullPath);
      }
    }
  }

  walk(appDir);
  return { pageFiles, apiFiles };
}

/**
 * Scan the app directory for all layout.tsx files (excluding the root layout).
 * Returns an array of absolute file paths.
 *
 * The root layout (app/layout.tsx) is NOT included because it is always
 * required and handled separately as RouteStore.RootLayout. Only nested
 * layouts (app/blog/layout.tsx, etc.) are returned here.
 */
function scanAppLayouts(appDir: string): string[] {
  const layouts: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (layoutFilePattern.test(fullPath)) {
        // Skip root layout — it's handled separately
        if (fullPath === join(appDir, "layout.tsx") ||
            fullPath === join(appDir, "layout.ts") ||
            fullPath === join(appDir, "layout.jsx") ||
            fullPath === join(appDir, "layout.js")) {
          continue;
        }
        layouts.push(fullPath);
      }
    }
  }

  walk(appDir);
  return layouts;
}

/**
 * Resolve the layout chain for a page route. Returns an array of layout
 * file paths ordered from nearest to the page (innermost) to the root
 * app directory (outermost, but NOT including the root layout itself).
 *
 * For a page at app/blog/[slug]/page.tsx, this returns:
 *   ["/abs/app/blog/[slug]/layout.tsx", "/abs/app/blog/layout.tsx"]
 * (if both exist)
 *
 * For a page at app/about/page.tsx, this returns:
 *   ["/abs/app/about/layout.tsx"]
 * (if it exists, otherwise [])
 *
 * For the root page at app/page.tsx, this returns [] (no nested layouts).
 *
 * The root layout (app/layout.tsx) is NOT included in this chain because
 * it is always the outermost wrapper and stored separately in
 * RouteStore.RootLayout.
 */
function resolveLayoutChain(appDir: string, pageFilePath: string): string[] {
  const relativePath = pageFilePath.slice(appDir.length + 1);
  const routeDir = relativePath.replace(routeFilePattern, "");

  // Root page has no nested layouts
  if (!routeDir) return [];

  // Walk from the page's directory up to appDir, collecting layout files.
  // At each level, check if a layout file exists (it's optional).
  // The loop stops before reaching appDir itself, so the root layout
  // (app/layout.tsx) is never included — it's stored separately in
  // RouteStore.RootLayout.
  const layouts: string[] = [];
  let currentDir = join(appDir, routeDir);

  while (currentDir !== appDir && currentDir.startsWith(appDir)) {
    // Check for layout file at this level (without throwing if not found)
    for (const extension of moduleExtensions) {
      const candidate = join(currentDir, `layout${extension}`);
      if (existsSync(candidate)) {
        layouts.push(candidate);
        break; // Found a layout at this level, move up
      }
    }
    currentDir = dirname(currentDir);
  }

  return layouts;
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
    routes: [{ path: "/", Page: indexModule.default, filePath: "src/index", layouts: [] }],
    nestedLayouts: new Map(),
  };
}

async function loadAppModules(root: string, config: MeidenConfig): Promise<AppModules> {
  const appDir = resolveAppDir(root, config);

  if (!existsSync(appDir)) {
    try {
      return await loadLegacyModules(root);
    } catch (legacyError) {
      // Provide a clear error that lists every path we tried
      const tried = [
        `  - ${appDir} (app directory)`,
        `  - ${join(root, "src", "layout.tsx")} + ${join(root, "src", "index.tsx")} (legacy)`,
      ];
      throw new Error(
        `Could not find app directory or legacy entry files. Tried:\n${tried.join("\n")}\n\n` +
        `Create an app directory with layout.tsx and page.tsx, or configure meiden.config.ts with appDir.`,
      );
    }
  }

  const layoutModule = await import(pathToFileURL(createServerModule(root, resolveAppModule(appDir, "layout"))).href);

  // Build the route manifest instead of the old scan+toRoutePath approach.
  // The manifest provides regex patterns, parsed segments, and param names
  // for dynamic route support ([slug], [...path]).
  const manifest = buildRouteManifest(appDir);

  if (!layoutModule.default || manifest.length === 0) {
    throw new Error("Meiden app router projects must export src/app/layout and at least one page or route.");
  }

  // Load each route module in isolation — a broken page/api route should not
  // kill the entire server. Failed routes get an error handler that
  // triggers a 500 when visited.
  const routes = await Promise.all(
    manifest.map(async (entry) => {
      try {
        const routeModule = await import(pathToFileURL(createServerModule(root, entry.filePath)).href);

        if (entry.kind === "page") {
          if (!routeModule.default) {
            console.warn(`[meiden] Page has no default export: ${entry.filePath}`);
            return {
              ...entry,
              Page: () => {
                throw new Error(`Page missing default export: ${entry.filePath}`);
              },
            };
          }
          return {
            ...entry,
            Page: routeModule.default,
            // Extract optional load() export for server-side data fetching.
            // If the page module exports a `load` function, it will be called
            // during SSR with route params and the result passed as `data` prop.
            load: typeof routeModule.load === "function" ? routeModule.load : undefined,
          };
        }

        // API route: collect exported HTTP method handlers
        const handlers: Record<string, (ctx: ApiRouteContext) => any | Promise<any>> = {};
        for (const method of API_METHODS) {
          if (typeof routeModule[method] === "function") {
            handlers[method] = routeModule[method];
          }
        }
        if (Object.keys(handlers).length === 0) {
          console.warn(`[meiden] API route has no HTTP method exports: ${entry.filePath}`);
        }
        return {
          ...entry,
          handlers,
        };
      } catch (error) {
        // Import-time failure (syntax error, missing dep, etc.)
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[meiden] Failed to load ${entry.kind} module ${entry.filePath}: ${message}`);
        if (entry.kind === "page") {
          return {
            ...entry,
            Page: () => {
              throw new Error(`Failed to load page: ${message}`);
            },
          };
        }
        // API route failure: set a handler that always throws
        return {
          ...entry,
          handlers: {
            GET: () => { throw new Error(`Failed to load API route: ${message}`); },
          },
        };
      }
    }),
  );

  // Load nested layout modules. Each layout is loaded in isolation —
  // a broken layout only affects routes that use it, not the whole server.
  // Failed layouts get a throwing component that triggers 500 for the
  // affected routes.
  const layoutFilePaths = scanAppLayouts(appDir);
  const nestedLayouts = new Map<string, Component<{ children: unknown }>>();

  await Promise.all(
    layoutFilePaths.map(async (layoutPath) => {
      try {
        const layoutModule = await import(pathToFileURL(createServerModule(root, layoutPath)).href);

        if (!layoutModule.default) {
          console.warn(`[meiden] Nested layout has no default export: ${layoutPath}`);
          nestedLayouts.set(layoutPath, () => {
            throw new Error(`Layout missing default export: ${layoutPath}`);
          });
          return;
        }

        nestedLayouts.set(layoutPath, layoutModule.default);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[meiden] Failed to load nested layout ${layoutPath}: ${message}`);
        nestedLayouts.set(layoutPath, () => {
          throw new Error(`Failed to load layout: ${message}`);
        });
      }
    }),
  );

  return {
    RootLayout: layoutModule.default,
    routes,
    nestedLayouts,
  };
}

// ─── SSR Rendering ─────────────────────────────────────────────────

export async function renderReact(root: string, element: unknown, renderer?: (element: any) => string) {
  if (typeof element === "string") {
    return injectIslandRuntime(`<!DOCTYPE html>${element}`, "/_meiden/islands/runtime.js");
  }

  let renderToString = renderer;

  if (!renderToString) {
    const requireFromApp = createRequire(join(root, "package.json"));
    const reactDomServerUrl = pathToFileURL(requireFromApp.resolve("react-dom/server")).href;
    const mod = await import(reactDomServerUrl);
    renderToString = mod.renderToString;
  }

  if (!renderToString) {
    throw new Error("Could not find renderToString");
  }

  return injectIslandRuntime(`<!DOCTYPE html>${renderToString(element)}`, "/_meiden/islands/runtime.js");
}

// ─── Island Runtime ────────────────────────────────────────────────

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

// ─── Build Pipeline ────────────────────────────────────────────────

/**
 * Build all island bundles in a single Bun.build call with code splitting.
 * This ensures React and ReactDOM are shared across islands instead of
 * being duplicated in every bundle.
 *
 * Returns a mapping from island key ("source#exportName") to its bundle
 * content, plus the shared chunk names and their contents.
 */
async function buildAllIslandBundles(
  root: string,
  islandList: IslandReference[],
  options: { minify?: boolean; development?: boolean } = {},
) {
  const tmpDir = join(root, ".meiden", "islands");
  mkdirSync(tmpDir, { recursive: true });

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

  // Create entry points for each island, tracking the mapping
  // from entry filename → island key for reliable matching
  const entrypoints: string[] = [];
  const entryToIslandKey = new Map<string, string>(); // entry basename (.js) → island key

  for (const island of islandList) {
    const islandPath = resolve(root, island.source);

    if (!islandPath.startsWith(`${root}/`) || !existsSync(islandPath)) {
      throw new Error(`Island not found: ${island.source}`);
    }

    const compiledIslandContent = await reactTranspiler.transform(await Bun.file(islandPath).text(), "tsx");
    const compiledIslandPath = join(tmpDir, `source-${hash(`${island.source}:${compiledIslandContent}`)}.js`);
    const compiledIslandImportPath = relative(tmpDir, compiledIslandPath).replaceAll("\\", "/");
    const compiledIslandSpecifier = compiledIslandImportPath.startsWith(".")
      ? compiledIslandImportPath
      : `./${compiledIslandImportPath}`;

    writeFileIfChanged(compiledIslandPath, compiledIslandContent);

    const key = `${island.source}#${island.exportName}`;

    // Use a deterministic name based on island identity (not content)
    // so we can reliably match the build output back to this island
    const entryBasename = `island-${hash(`${island.source}:${island.exportName}`)}`;

    const entryContent = `
/** @jsxImportSource react */
import React from "react";
import { hydrateRoot } from "react-dom/client";
import * as islandModule from ${JSON.stringify(compiledIslandSpecifier)};

const Component = islandModule[${JSON.stringify(island.exportName)}];

export default function hydrate(target, props) {
  hydrateRoot(target, React.createElement(Component, props));
}
`;
    const entryPath = join(tmpDir, `${entryBasename}.tsx`);
    writeFileIfChanged(entryPath, entryContent);
    entrypoints.push(entryPath);

    // Map the expected output filename back to the island key
    entryToIslandKey.set(`${entryBasename}.js`, key);
  }

  if (entrypoints.length === 0) {
    return { islandOutputs: new Map<string, string>(), sharedChunks: new Map<string, string>() };
  }

  // Build all islands together with splitting enabled for shared React chunk
  const build = await Bun.build({
    entrypoints,
    target: "browser",
    format: "esm",
    splitting: true,
    tsconfig: tsconfigPath,
    jsx: {
      runtime: "automatic",
      importSource: "react",
      development: options.development ?? true,
    },
    minify: options.minify ?? false,
  });

  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n") || "Failed to build islands");
  }

  // Map each output to its island key or shared chunk
  const islandOutputs = new Map<string, string>(); // island key → content
  const sharedChunks = new Map<string, string>(); // chunk name → content

  for (const output of build.outputs) {
    const content = await output.text();
    const name = output.path.split("/").pop() || output.path;

    const islandKey = entryToIslandKey.get(name);
    if (islandKey) {
      // This is an entry point output — map directly to its island
      islandOutputs.set(islandKey, content);
    } else {
      // This is a shared chunk (React, ReactDOM, etc.)
      sharedChunks.set(name, content);
    }
  }

  return { islandOutputs, sharedChunks };
}

async function buildIslandBundle(
  root: string,
  source: string,
  exportName: string,
  options: { minify?: boolean; development?: boolean } = {},
) {
  const key = `${source}#${exportName}`;
  const { islandOutputs } = await buildAllIslandBundles(root, [{ source, exportName }], options);
  return islandOutputs.get(key) || "";
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

// ─── Layout & Route Rendering ──────────────────────────────────────

/**
 * Create a layout wrapper that renders the full layout chain:
 *
 *   RootLayout > NestedLayoutN > ... > NestedLayout1 > Page
 *
 * The root layout is always the outermost wrapper. Nested layouts are
 * applied in reverse order of entry.layouts (which is nearest-first),
 * so the outermost nested layout (closest to root) wraps first, and
 * the innermost nested layout (closest to the page) wraps last.
 *
 * If a nested layout component is missing from nestedLayouts (e.g.
 * because it failed to load), a throwing placeholder is used that
 * triggers a 500 for routes that depend on it — but NOT for routes
 * that don't use this layout.
 */
export function createLayoutWrapper(
  RootLayout: AppModules["RootLayout"],
  layoutChain: string[],
  nestedLayouts: Map<string, Component<{ children: unknown }>>,
) {
  return function LayoutWrapper({ Page, params, data }: LayoutWrapperProps): any {
    // Start with the page component, then wrap with layouts from
    // innermost (nearest to page) to outermost (nearest to root).
    // entry.layouts is ordered nearest-first, so we iterate in order.
    // If the page has a load() function, pass the resolved data as a prop.
    let element: any = <Page params={params} data={data} />;

    for (const layoutPath of layoutChain) {
      const LayoutComponent = nestedLayouts.get(layoutPath);
      if (LayoutComponent) {
        element = <LayoutComponent>{element}</LayoutComponent>;
      } else {
        // Layout file was listed but not loaded — this shouldn't
        // normally happen, but if it does, use a throwing placeholder
        element = (() => { throw new Error(`Layout not loaded: ${layoutPath}`); })();
      }
    }

    // Root layout is always the outermost wrapper
    return <RootLayout>{element}</RootLayout>;
  };
}

async function renderRoute(root: string, LayoutWrapper: Component<LayoutWrapperProps>, route: AppRoute, data?: unknown) {
  return renderReact(root, <LayoutWrapper Page={route.Page} params={{}} data={data} />);
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

/**
 * Rewrite island script imports in HTML to include shared chunks.
 * Shared chunks (React, ReactDOM) must be loaded before island scripts.
 */
function injectSharedChunkScripts(html: string, sharedChunkPaths: string[]): string {
  if (sharedChunkPaths.length === 0) {
    return html;
  }

  const scripts = sharedChunkPaths
    .map(path => `<script type="module" src="${path}"></script>`)
    .join("\n");

  // Insert shared chunks before the runtime script
  const runtimeScript = '<script type="module" src="/_meiden/islands/runtime.js">';
  if (html.includes(runtimeScript)) {
    return html.replace(runtimeScript, `${scripts}\n${runtimeScript}`);
  }

  // Fallback: insert before </body>
  if (html.includes("</body>")) {
    return html.replace("</body>", `${scripts}\n</body>`);
  }

  return `${html}${scripts}`;
}

// ─── Build ─────────────────────────────────────────────────────────

export async function buildApp({
  root,
  outDir = "dist",
  minify = true,
}: BuildOptions): Promise<BuildResult> {
  const projectRoot = resolve(root);
  const outputRoot = resolve(projectRoot, outDir);
  const config = await loadConfig(projectRoot);
  const appDir = resolveAppDir(projectRoot, config);
  const { RootLayout, routes, nestedLayouts } = await loadAppModules(projectRoot, config);
  const rendered = new Map<AppRoute, string>();
  const islands = new Map<string, IslandReference>();
  const assets: BuildResult["assets"] = [];

  // Separate routes by kind and dynamism for different build strategies
  const staticPageRoutes = routes.filter(r => r.kind === "page" && !r.isDynamic);
  const dynamicPageRoutes = routes.filter(r => r.kind === "page" && r.isDynamic);
  const apiRoutes = routes.filter(r => r.kind === "api");
  const needsRuntimeServer = dynamicPageRoutes.length > 0 || apiRoutes.length > 0;

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  copyPublicDir(join(projectRoot, "public"), outputRoot);

  // Build a set of paths that have API routes, so we can skip
  // pre-rendering pages that share the same path. API routes must
  // take priority over page routes at the same URL — if we pre-render
  // the page to a static HTML file, the production server would serve
  // that file before ever reaching the API route handler.
  const apiRoutePaths = new Set(apiRoutes.map(r => r.path));

  // Pre-render only static page routes to HTML, unless the path
  // is shadowed by an API route (API routes take priority).
  for (const route of staticPageRoutes) {
    // Skip pre-rendering if an API route exists at the same path.
    // The runtime server will handle this path via the API route.
    if (apiRoutePaths.has(route.path)) {
      continue;
    }

    // Call load() if the page exports one, passing empty params for
    // static builds (static routes have no dynamic params).
    let data: unknown = undefined;
    if (route.load) {
      data = await route.load({ params: {} });
    }

    const LayoutWrapper = createLayoutWrapper(RootLayout, route.layouts, nestedLayouts);
    const html = await renderRoute(projectRoot, LayoutWrapper, route, data);
    rendered.set(route, html);

    for (const island of getIslands(html)) {
      islands.set(`${island.source}#${island.exportName}`, island);
    }
  }

  const manifest: Record<string, string> = {};
  const islandList = [...islands.values()];

  // Build all islands together with splitting for shared React chunk
  const { islandOutputs, sharedChunks } = await buildAllIslandBundles(projectRoot, islandList, {
    minify,
    development: false,
  });

  // Write shared chunks (React, ReactDOM shared across islands)
  const sharedChunkPaths: string[] = [];
  for (const [chunkName, content] of sharedChunks) {
    const publicPath = `/_meiden/islands/${chunkName}`;
    const outputPath = join(outputRoot, "_meiden", "islands", chunkName);
    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileIfChanged(outputPath, content);
    sharedChunkPaths.push(publicPath);

    assets.push({
      name: `/_meiden/islands/${chunkName}`,
      size: Buffer.byteLength(content),
      type: "shared",
    });
  }

  // Write island entry bundles and build manifest
  for (const [islandKey, content] of islandOutputs) {
    const fileName = `${hash(`${islandKey}:${content}`)}.js`;
    const publicPath = `/_meiden/islands/${fileName}`;
    const outputPath = join(outputRoot, "_meiden", "islands", fileName);

    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileIfChanged(outputPath, content);
    manifest[islandKey] = publicPath;

    assets.push({
      name: `/_meiden/islands/${fileName}`,
      size: Buffer.byteLength(content),
      type: "island",
    });
  }

  // Only write runtime.js if there are islands.
  // When there are no interactive components, the HTML won't include
  // data-meiden-island attributes, so injectIslandRuntime skips the
  // script tag — and there's no point shipping an empty runtime.
  if (islands.size > 0) {
    const runtimeContent = createIslandRuntime(manifest);
    const runtimePath = join(outputRoot, "_meiden", "islands", "runtime.js");
    mkdirSync(resolve(runtimePath, ".."), { recursive: true });
    writeFileIfChanged(runtimePath, runtimeContent);
    assets.push({
      name: "/_meiden/islands/runtime.js",
      size: Buffer.byteLength(runtimeContent),
      type: "runtime",
    });
  }

  // Write pre-rendered static HTML files
  for (const [route, html] of rendered) {
    // Inject shared chunk scripts into the HTML
    const finalHtml = injectSharedChunkScripts(html, sharedChunkPaths);
    const outputPath = routeOutputPath(outputRoot, route.path);

    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileIfChanged(outputPath, finalHtml);

    assets.push({
      name: route.path === "/" ? "/index.html" : `${route.path}/index.html`,
      size: Buffer.byteLength(finalHtml),
      type: "route",
    });
  }

  // Build the production server
  // When there are dynamic routes or API routes, we need a runtime server
  // that can match routes and render/dispatch on demand.
  if (needsRuntimeServer) {
    // Bundle server modules for dynamic routes and API routes
    const serverModulesDir = join(outputRoot, "_meiden", "server");
    mkdirSync(serverModulesDir, { recursive: true });

    // Build the route manifest data for the production server.
    // This includes all routes (static + dynamic + API) so the server can
    // match URLs and dispatch to the correct handler.
    const productionManifest = buildProductionManifest(
      appDir,
      routes,
      projectRoot,
      outputRoot,
      serverModulesDir,
    );

    // Bundle the root layout
    const rootLayoutModulePath = createServerModule(projectRoot, resolveAppModule(appDir, "layout"));
    const rootLayoutDest = join(serverModulesDir, "root-layout.js");
    await bundleServerModule(rootLayoutModulePath, rootLayoutDest, projectRoot);

    // Bundle nested layouts
    for (const [layoutPath, _component] of nestedLayouts) {
      const serverModulePath = createServerModule(projectRoot, layoutPath);
      const layoutHash = hash(layoutPath);
      const destPath = join(serverModulesDir, `layout-${layoutHash}.js`);
      await bundleServerModule(serverModulePath, destPath, projectRoot);
    }

    // Bundle dynamic page route modules
    for (const route of dynamicPageRoutes) {
      const serverModulePath = createServerModule(projectRoot, route.filePath);
      const routeHash = hash(route.filePath);
      const destPath = join(serverModulesDir, `page-${routeHash}.js`);
      await bundleServerModule(serverModulePath, destPath, projectRoot);
    }

    // Bundle API route modules
    for (const route of apiRoutes) {
      const serverModulePath = createServerModule(projectRoot, route.filePath);
      const routeHash = hash(route.filePath);
      const destPath = join(serverModulesDir, `api-${routeHash}.js`);
      await bundleServerModule(serverModulePath, destPath, projectRoot);
    }

    // Also bundle static page modules so the runtime server can serve them
    // (for cases where the static HTML file isn't found, e.g. during
    // development of the production server)
    for (const route of staticPageRoutes) {
      const serverModulePath = createServerModule(projectRoot, route.filePath);
      const routeHash = hash(route.filePath);
      const destPath = join(serverModulesDir, `page-${routeHash}.js`);
      await bundleServerModule(serverModulePath, destPath, projectRoot);
    }

    await buildRuntimeServer(outputRoot, productionManifest, sharedChunkPaths);
  } else {
    // Pure static site — use the lightweight static file server
    await buildStaticServer(outputRoot, routes);
  }

  return {
    outDir: outputRoot,
    routes: routes.length,
    islands: islands.size,
    assets: assets.sort((a, b) => b.size - a.size),
  };
}

// ─── Production Manifest & Bundling ─────────────────────────────────

/**
 * Serializable route manifest entry for the production server.
 * This is a subset of RouteManifestEntry that can be embedded in the
 * generated server.js — it excludes runtime-only fields like Page and
 * handlers, and uses string regex patterns instead of RegExp objects.
 */
interface ProductionManifestEntry {
  kind: RouteKind;
  path: string;
  /** Regex pattern string (e.g. "^\\/blog\\/([^/]+)$") */
  pattern: string;
  params: string[];
  isDynamic: boolean;
  /** Module path relative to serverModulesDir */
  modulePath: string;
  /** Layout module paths relative to serverModulesDir, nearest-first */
  layoutModulePaths: string[];
  /** Root layout module path relative to serverModulesDir */
  rootLayoutModulePath: string;
}

/**
 * Build the production route manifest — a serializable data structure
 * that the generated server.js uses for route matching and module loading.
 *
 * Each entry maps to a bundled server module in dist/_meiden/server/.
 * The module paths are relative to the server modules directory so the
 * generated server.js can resolve them at runtime.
 */
function buildProductionManifest(
  appDir: string,
  routes: RouteManifestEntry[],
  projectRoot: string,
  outputRoot: string,
  serverModulesDir: string,
): ProductionManifestEntry[] {
  return routes.map(route => {
    const routeHash = hash(route.filePath);

    // Determine the module filename based on route kind
    let moduleFilename: string;
    if (route.kind === "api") {
      moduleFilename = `api-${routeHash}.js`;
    } else {
      moduleFilename = `page-${routeHash}.js`;
    }

    // Build layout module filenames
    const layoutModulePaths = route.layouts.map(layoutPath => {
      const layoutHash = hash(layoutPath);
      return `layout-${layoutHash}.js`;
    });

    return {
      kind: route.kind,
      path: route.path,
      pattern: route.pattern.source,
      params: route.params,
      isDynamic: route.isDynamic,
      modulePath: moduleFilename,
      layoutModulePaths,
      rootLayoutModulePath: "root-layout.js",
    };
  });
}

/**
 * Bundle a server module (created by createServerModule) into a
 * self-contained JavaScript file that can be imported by the production
 * server at runtime.
 *
 * Uses Bun.build() to resolve and bundle all dependencies so the
 * production server doesn't need access to the source directory or
 * node_modules at runtime.
 */
async function bundleServerModule(
  serverModulePath: string,
  destPath: string,
  projectRoot: string,
): Promise<void> {
  let buildSucceeded = false;

  try {
    const result = await Bun.build({
      entrypoints: [serverModulePath],
      outdir: resolve(destPath, ".."),
      naming: `[name].[ext]`,
      target: "bun",
      format: "esm",
      minify: false,
      splitting: false,
      external: [],
    });

    if (result.success && result.outputs.length > 0) {
      const content = await result.outputs[0].text();
      writeFileIfChanged(destPath, content);
      buildSucceeded = true;
      return;
    }

    if (!result.success) {
      // Silently fall through to transpiler fallback
    }
  } catch {
    // Silently fall through to transpiler fallback
  }

  // Fallback: Use Bun.Transpiler to transform TSX to JS.
  // This produces a self-contained module that can be imported by Bun.
  // The imports (like `import React from "react"`) are preserved so they
  // resolve at runtime from the project's node_modules.
  if (!buildSucceeded && existsSync(serverModulePath)) {
    try {
      const source = readFileSync(serverModulePath, "utf8");
      const transpiler = new Bun.Transpiler({
        loader: serverModulePath.endsWith(".tsx") ? "tsx" : "ts",
        target: "bun",
        tsconfig: {
          compilerOptions: {
            jsx: "react",
            jsxFactory: "React.createElement",
            jsxFragmentFactory: "React.Fragment",
          },
        },
      });
      const transformed = await transpiler.transform(source);
      writeFileIfChanged(destPath, typeof transformed === "string" ? transformed : new TextDecoder().decode(transformed as Uint8Array));
    } catch {
      // Last resort: copy the raw file as-is
      const content = readFileSync(serverModulePath, "utf8");
      writeFileIfChanged(destPath, content);
    }
  }
}

// ─── Runtime Server Generation ──────────────────────────────────────

/**
 * Build a production server with runtime route matching and SSR.
 *
 * This server supports:
 * - Static file serving (public/, pre-rendered HTML, island bundles)
 * - Dynamic page routes with SSR (regex pattern matching, params extraction)
 * - API route method dispatch (GET, POST, PUT, DELETE, etc.)
 * - 405 Method Not Allowed for unsupported methods on API routes
 * - Controlled 500 on import/runtime errors
 * - Safe URL decoding with 404 for malformed percent-encoding
 *
 * The server embeds the route manifest data and loads modules from
 * dist/_meiden/server/ at runtime via dynamic import().
 */
async function buildRuntimeServer(
  outputRoot: string,
  manifest: ProductionManifestEntry[],
  sharedChunkPaths: string[],
) {
  const contentTypeEntries = Object.entries(getContentTypeMapForServer())
    .map(([ext, type]) => `  ${JSON.stringify(ext)}: ${JSON.stringify(type)}`)
    .join(",\n");

  // Serialize the manifest for embedding in server.js
  const manifestSource = JSON.stringify(manifest, null, 2);

  // Serialize shared chunk paths for injecting into SSR HTML
  const sharedChunkScripts = sharedChunkPaths
    .map(p => `<script type="module" src="${p}"></script>`)
    .join("\\n");

  const entryContent = `
import { existsSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { renderToString } from "react-dom/server";
import React from "react";

const distRoot = import.meta.dir;
const serverModulesDir = join(distRoot, "_meiden", "server");
const contentTypes = {
${contentTypeEntries}
};

// Route manifest embedded from build time
const routeManifest = ${manifestSource};

// Build lookup structures: static routes by exact path, dynamic routes
// for sequential regex matching (same strategy as dev server)
// API routes are separated into their own list so they can be checked
// before static file serving (API routes take priority).
const staticRoutes = new Map();
const dynamicRoutes = [];
const apiRoutes = [];

for (const entry of routeManifest) {
  // API routes always need runtime matching (they're never pre-rendered)
  if (entry.kind === "api") {
    apiRoutes.push({ ...entry, pattern: new RegExp(entry.pattern) });
    continue;
  }
  // Dynamic page routes need runtime matching
  if (entry.isDynamic) {
    dynamicRoutes.push({ ...entry, pattern: new RegExp(entry.pattern) });
    continue;
  }
  // Static page routes: indexed by exact path for O(1) lookup
  staticRoutes.set(entry.path, entry);
  // Also add to dynamicRoutes as fallback if static HTML not found
  dynamicRoutes.push({ ...entry, pattern: new RegExp(entry.pattern) });
}

// Module cache: loaded modules are cached so they're only imported once
const moduleCache = new Map();

async function loadModule(modulePath) {
  if (moduleCache.has(modulePath)) {
    return moduleCache.get(modulePath);
  }
  const fullPath = join(serverModulesDir, modulePath);
  const mod = await import(fullPath);
  moduleCache.set(modulePath, mod);
  return mod;
}

function safeDecodeURIComponent(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchRoute(pathname) {
  // Fast path: exact match for static routes
  const staticEntry = staticRoutes.get(pathname);
  if (staticEntry) {
    return { entry: staticEntry, params: {} };
  }

  // Try each dynamic route pattern
  for (const entry of dynamicRoutes) {
    const match = pathname.match(entry.pattern);
    if (match) {
      const params = {};
      for (let i = 0; i < entry.params.length; i++) {
        const paramName = entry.params[i];
        const captured = match[i + 1];
        const decoded = captured ? safeDecodeParam(captured) : "";
        if (decoded === null) return undefined; // malformed encoding -> no match
        params[paramName] = decoded;
      }
      return { entry, params };
    }
  }

  return undefined;
}

function resolveBuiltFile(requestPath) {
  let pathname;
  try {
    pathname = safeDecodeURIComponent(new URL(requestPath, "http://meiden.local").pathname);
  } catch {
    return undefined;
  }
  if (pathname === null) return undefined;
  const cleanPath = pathname.replace(/^\\/+/, "");
  const candidates = [
    cleanPath ? join(distRoot, cleanPath) : join(distRoot, "index.html"),
    join(distRoot, cleanPath, "index.html"),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!resolved.startsWith(distRoot + "/") && resolved !== distRoot) continue;
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  return undefined;
}

async function renderPage(entry, params) {
  // Load the page module
  const pageMod = await loadModule(entry.modulePath);
  if (!pageMod.default) {
    throw new Error("Page module has no default export");
  }
  const Page = pageMod.default;
  const loadFn = typeof pageMod.load === "function" ? pageMod.load : undefined;

  // Call load() if exported
  let data = undefined;
  if (loadFn) {
    data = await loadFn({ params });
  }

  // Load and build the layout chain
  const RootLayoutMod = await loadModule(entry.rootLayoutModulePath);
  const RootLayout = RootLayoutMod.default;
  if (!RootLayout) {
    throw new Error("Root layout module has no default export");
  }

  // Load nested layouts (nearest first → wrap from innermost to outermost)
  let element = React.createElement(Page, { params, data });
  for (const layoutPath of entry.layoutModulePaths) {
    const layoutMod = await loadModule(layoutPath);
    if (layoutMod.default) {
      element = React.createElement(layoutMod.default, null, element);
    }
  }
  // Root layout is always outermost
  element = React.createElement(RootLayout, null, element);

  // SSR render
  const html = "<!DOCTYPE html>" + renderToString(element);

  // Inject island runtime and shared chunks if HTML contains islands
  const hasIslands = html.includes("data-meiden-island");
  let finalHtml = html;
  if (hasIslands) {
    const runtimeScript = '<script type="module" src="/_meiden/islands/runtime.js">';
    const chunksPlusRuntime = "${sharedChunkScripts}\\n" + runtimeScript;
    if (finalHtml.includes(runtimeScript)) {
      finalHtml = finalHtml.replace(runtimeScript, chunksPlusRuntime);
    } else if (finalHtml.includes("</body>")) {
      finalHtml = finalHtml.replace("</body>", chunksPlusRuntime + "</script></body>");
    }
  }

  return finalHtml;
}

async function handleApiRoute(entry, params, request) {
  const apiMod = await loadModule(entry.modulePath);
  const method = request.method;

  const handler = apiMod[method];
  if (typeof handler !== "function") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: Object.keys(apiMod).filter(k => typeof apiMod[k] === "function").join(", ") } });
  }

  return handler({ request, params });
}

const port = Number(process.env.PORT) || 3000;

Bun.serve({
  port,
  async fetch(request) {
    const startedAt = performance.now();
    let pathname;
    try { pathname = new URL(request.url).pathname; } catch { pathname = request.url; }
    const method = request.method;

    // 1. Check if the path matches an API route first.
    // API routes take priority over static file serving and page routes,
    // matching the dev server's behavior where API routes are checked
    // before page routes at the same path. Without this check, a
    // pre-rendered HTML file for a page at the same path would be
    // served before the API route handler ever gets a chance.
    for (const entry of apiRoutes) {
      const match = pathname.match(entry.pattern);
      if (match) {
        const params = {};
        for (let i = 0; i < entry.params.length; i++) {
          const paramName = entry.params[i];
          const captured = match[i + 1];
          const decoded = captured ? safeDecodeParam(captured) : "";
          if (decoded === null) break;
          params[paramName] = decoded;
        }
        try {
          const response = await handleApiRoute(entry, params, request);
          const status = response instanceof Response ? response.status : 200;
          const duration = (performance.now() - startedAt).toFixed(1);
          const statusStr = String(status).padStart(3);
          const colorCode = status >= 400 ? "\\x1b[31m" : "\\x1b[32m";
          console.log(colorCode + statusStr + "\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[meiden] Production error for " + pathname + ": " + message);
          const duration = (performance.now() - startedAt).toFixed(1);
          console.log("\\x1b[31m500\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
          return new Response("Internal Server Error", { status: 500 });
        }
      }
    }

    // 2. Try static file serving (public/, pre-rendered HTML, island bundles)
    const filePath = resolveBuiltFile(request.url);
    if (filePath) {
      const duration = (performance.now() - startedAt).toFixed(1);
      console.log("\\x1b[32m200\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
      const ext = extname(filePath);
      return new Response(Bun.file(filePath), {
        headers: { "content-type": contentTypes[ext] || "application/octet-stream" },
      });
    }

    // 3. Try route manifest matching (dynamic pages, static pages as fallback)
    const match = matchRoute(pathname);
    if (!match) {
      const duration = (performance.now() - startedAt).toFixed(1);
      console.log("\\x1b[31m404\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
      return new Response("Not found", { status: 404 });
    }

    const { entry, params } = match;

    try {
      // Page route: SSR
      const html = await renderPage(entry, params);
      const duration = (performance.now() - startedAt).toFixed(1);
      console.log("\\x1b[32m200\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[meiden] Production error for " + pathname + ": " + message);
      const duration = (performance.now() - startedAt).toFixed(1);
      console.log("\\x1b[31m500\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

console.log("");
console.log("\\x1b[36mMeiden\\x1b[0m \\x1b[32mproduction server ready\\x1b[0m");
console.log("");
console.log("  \\x1b[2mLocal:\\x1b[0m   http://localhost:" + port);
console.log("");
`;

  writeFileIfChanged(join(outputRoot, "server.js"), entryContent);
}

// ─── Static Server Generation ──────────────────────────────────────

/**
 * Build a lightweight production server that serves static files.
 * No React or Elysia bundled — just Bun.serve for static files.
 *
 * Uses the unified content-type map from runtime/utils.ts.
 * Includes safe URL decoding with try/catch for malformed URIs.
 */
async function buildStaticServer(outDir: string, routes: AppRoute[]) {
  const contentTypeEntries = Object.entries(getContentTypeMapForServer())
    .map(([ext, type]) => `  ${JSON.stringify(ext)}: ${JSON.stringify(type)}`)
    .join(",\n");

  const entryContent = `
const { existsSync, statSync } = require("node:fs");
const { join, resolve, extname } = require("node:path");

const distRoot = import.meta.dir;
const contentTypes = {
${contentTypeEntries}
};

function safeDecodeURIComponent(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function resolveBuiltFile(requestPath) {
  let pathname;
  try {
    pathname = safeDecodeURIComponent(new URL(requestPath, "http://meiden.local").pathname);
  } catch {
    return undefined;
  }
  const cleanPath = pathname.replace(/^\\/+/, "");
  const candidates = [
    cleanPath ? join(distRoot, cleanPath) : join(distRoot, "index.html"),
    join(distRoot, cleanPath, "index.html"),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!resolved.startsWith(distRoot + "/") && resolved !== distRoot) continue;
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  return undefined;
}

const port = Number(process.env.PORT) || 3000;

Bun.serve({
  port,
  fetch(request) {
    const startedAt = performance.now();
    const filePath = resolveBuiltFile(request.url);
    const method = request.method;
    let pathname;
    try { pathname = new URL(request.url).pathname; } catch { pathname = request.url; }

    if (!filePath) {
      const duration = (performance.now() - startedAt).toFixed(1);
      console.log("\\x1b[31m404\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");
      return new Response("Not found", { status: 404 });
    }

    const duration = (performance.now() - startedAt).toFixed(1);
    console.log("\\x1b[32m200\\x1b[0m  " + method.padEnd(4) + "  " + pathname.padEnd(8) + "  " + duration + "ms");

    const ext = extname(filePath);
    return new Response(Bun.file(filePath), {
      headers: { "content-type": contentTypes[ext] || "application/octet-stream" },
    });
  },
});

console.log("");
console.log("\\x1b[36mMeiden\\x1b[0m \\x1b[32mproduction server ready\\x1b[0m");
console.log("");
console.log("  \\x1b[2mLocal:\\x1b[0m   http://localhost:" + port);
console.log("");
`;

  writeFileIfChanged(join(outDir, "server.js"), entryContent);
}

// ─── Production Server ─────────────────────────────────────────────

export function resolveBuiltFile(distRoot: string, requestPath: string) {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestPath, "http://meiden.local").pathname);
  } catch {
    // Malformed URL encoding — treat as not found
    return undefined;
  }

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

  // If a runtime server.js was generated (dynamic routes, API routes),
  // import it and let it handle everything. It includes static file
  // serving + route manifest matching + SSR + API dispatch.
  const serverJsPath = join(distRoot, "server.js");
  if (existsSync(serverJsPath)) {
    // Set the port via environment variable so the imported server uses it
    if (port) {
      process.env.PORT = String(port);
    }
    // Import the server module — it starts Bun.serve on import.
    // We need to await the import and then return the server instance.
    // However, since the imported module calls Bun.serve directly,
    // we can't easily get the server reference. Instead, we'll
    // start our own proxy that delegates to the imported server's
    // fetch handler.
    //
    // For simplicity and to avoid double-binding, we just return
    // a Bun.serve instance that uses the same logic as the generated
    // server but runs in-process. This is what the CLI does too
    // when it detects server.js — it imports it directly.
    //
    // The most practical approach: just import the server module.
    // This is what `meiden start` does via the CLI.
    import(pathToFileURL(serverJsPath).href).catch((error) => {
      console.error(`[meiden] Failed to import production server: ${error}`);
    });
    // Return a placeholder — the imported module starts its own server
    return { port } as any;
  }

  // Pure static site — no runtime server needed
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

// ─── Dev Server ────────────────────────────────────────────────────

/**
 * Concurrency limiter to prevent the dev server from being overwhelmed
 * by too many simultaneous requests. Bun's HTTP server can become
 * unresponsive under heavy concurrent load (200+ simultaneous connections).
 *
 * The counter is only incremented for requests that pass the concurrency
 * check. Requests rejected with 503 are never counted, so no decrement
 * is needed for them. For requests that are counted, we use a per-request
 * store flag (__meiden_counted) so that onAfterHandle/onError only
 * decrement once — even if onAfterHandle fires after onBeforeHandle
 * returns an early response (e.g., a static file).
 */
const MAX_CONCURRENT_REQUESTS = 100;
let inFlightRequests = 0;

/**
 * Mutable route store — route handlers read from this object so that
 * hot reload can update it without re-registering Elysia routes.
 *
 * The store holds both static and dynamic routes separately:
 * - staticRoutes: Map<pathname, RouteManifestEntry> for O(1) exact match
 * - dynamicRoutes: RouteManifestEntry[] for sequential pattern matching
 * This split enables fast lookups for static routes (the common case)
 * while still supporting dynamic routes ([slug], [...path]).
 */
interface RouteStore {
  RootLayout: Component<{ children: unknown }>;
  /** Static routes indexed by exact pathname for O(1) lookup */
  staticRoutes: Map<string, RouteManifestEntry>;
  /** Dynamic routes ordered by specificity (most specific first) */
  dynamicRoutes: RouteManifestEntry[];
  /** All routes indexed by filePath for hot reload lookups */
  routesByFilePath: Map<string, RouteManifestEntry>;
  /**
   * Nested layout components indexed by their file path.
   * When a nested layout is hot-reloaded, only the component in this
   * map is updated — all routes that reference this layout file path
   * in their entry.layouts array will automatically use the new version
   * on the next request because rendering reads from this map.
   */
  nestedLayouts: Map<string, Component<{ children: unknown }>>;
}

/**
 * Hot-reload a single page module. Regenerates the server module,
 * re-imports it, and updates the route store. Errors are logged but
 * do not crash the server — the old route stays active until the
 * broken file is fixed.
 *
 * Uses the route manifest entry from routesByFilePath to find the
 * existing entry, then updates it with the new Page component.
 */
async function hotReloadPage(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  const existingEntry = routeStore.routesByFilePath.get(filePath);
  if (!existingEntry) {
    // File not in manifest — this shouldn't happen for page files that
    // were loaded at startup, but handle it gracefully.
    console.warn(`[meiden] Hot reload: no manifest entry for ${filePath}`);
    return;
  }

  try {
    const serverModulePath = createServerModule(projectRoot, filePath);
    const pageModule = await import(pathToFileURL(serverModulePath).href);

    if (!pageModule.default) {
      console.warn(`[meiden] Hot reload: page has no default export: ${filePath}`);
      existingEntry.Page = () => {
        throw new Error(`Page missing default export: ${filePath}`);
      };
      existingEntry.load = undefined;
      return;
    }

    existingEntry.Page = pageModule.default;
    // Update the load() function if the module exports one, or clear it
    // if the module no longer exports load. This ensures hot-reloaded
    // pages with data loading changes take effect immediately.
    existingEntry.load = typeof pageModule.load === "function" ? pageModule.load : undefined;
    console.log(`[meiden] Hot reload: ${existingEntry.path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for ${filePath}: ${message}`);
    // Keep the old route active — don't break the server
  }
}

/**
 * Hot-reload the root layout module. Regenerates the server module,
 * re-imports it, and updates the route store's RootLayout.
 */
async function hotReloadRootLayout(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
) {
  const appDir = resolveAppDir(projectRoot, config);

  try {
    const layoutModule = await import(
      pathToFileURL(createServerModule(projectRoot, resolveAppModule(appDir, "layout"))).href
    );

    if (!layoutModule.default) {
      console.error("[meiden] Hot reload: root layout has no default export — keeping old layout");
      return;
    }

    routeStore.RootLayout = layoutModule.default;
    console.log("[meiden] Hot reload: root layout");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for root layout: ${message}`);
  }
}

/**
 * Hot-reload a nested layout module. Regenerates the server module,
 * re-imports it, and updates the component in routeStore.nestedLayouts.
 *
 * Only routes that reference this layout in their entry.layouts array
 * are affected. Other routes continue to use their existing (cached)
 * layout components and are not impacted.
 */
async function hotReloadNestedLayout(
  projectRoot: string,
  routeStore: RouteStore,
  layoutFilePath: string,
) {
  try {
    const layoutModule = await import(
      pathToFileURL(createServerModule(projectRoot, layoutFilePath)).href
    );

    if (!layoutModule.default) {
      console.error(`[meiden] Hot reload: nested layout has no default export: ${layoutFilePath}`);
      // Set a throwing placeholder so affected routes get 500
      routeStore.nestedLayouts.set(layoutFilePath, () => {
        throw new Error(`Layout missing default export: ${layoutFilePath}`);
      });
      return;
    }

    routeStore.nestedLayouts.set(layoutFilePath, layoutModule.default);
    console.log(`[meiden] Hot reload: nested layout ${layoutFilePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for nested layout ${layoutFilePath}: ${message}`);
    // Set a throwing placeholder so affected routes get 500 instead
    // of using stale code
    routeStore.nestedLayouts.set(layoutFilePath, () => {
      throw new Error(`Failed to load layout: ${message}`);
    });
  }
}

/**
 * Hot-reload an API route module. Regenerates the server module,
 * re-imports it, and updates the handlers on the route manifest entry.
 * Errors are logged but do not crash the server — the old handlers
 * stay active until the broken file is fixed.
 */
async function hotReloadApiRoute(
  projectRoot: string,
  routeStore: RouteStore,
  filePath: string,
) {
  const existingEntry = routeStore.routesByFilePath.get(filePath);
  if (!existingEntry || existingEntry.kind !== "api") {
    console.warn(`[meiden] Hot reload: no API route entry for ${filePath}`);
    return;
  }

  try {
    const serverModulePath = createServerModule(projectRoot, filePath);
    const routeModule = await import(pathToFileURL(serverModulePath).href);

    const handlers: Record<string, (ctx: ApiRouteContext) => any | Promise<any>> = {};
    for (const method of API_METHODS) {
      if (typeof routeModule[method] === "function") {
        handlers[method] = routeModule[method];
      }
    }

    if (Object.keys(handlers).length === 0) {
      console.warn(`[meiden] Hot reload: API route has no HTTP method exports: ${filePath}`);
    }

    existingEntry.handlers = handlers;
    console.log(`[meiden] Hot reload: API route ${existingEntry.path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for API route ${filePath}: ${message}`);
    // Keep the old handlers active
  }
}

/**
 * Hot-reload a component (or any non-page/layout) file. Uses the
 * dependency graph to find all pages and layouts that import this
 * file (directly or transitively), then re-imports each one.
 *
 * Because createServerModule recursively transforms the entire import
 * chain with content-hashed filenames, changing a component produces
 * a new component server module with a new hash → the page's import
 * specifier changes → the page's server module gets a new hash →
 * Bun's import() loads fresh code instead of the cached version.
 *
 * If no dependents are found (e.g. a new file that hasn't been
 * imported yet), this is a no-op.
 */
async function hotReloadComponent(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  // findDependents walks transitively, so we get all direct and
  // indirect dependents (including pages/layouts that import the
  // component through intermediate files).
  const dependents = findDependents(filePath);
  if (dependents.size === 0) {
    console.log(`[meiden] Hot reload: ${filePath} changed but no dependents found`);
    return;
  }

  for (const depPath of dependents) {
    if (!existsSync(depPath)) continue;

    if (layoutFilePattern.test(depPath)) {
      // Determine if this is the root layout or a nested layout
      const appDir = resolveAppDir(projectRoot, config);
      const rootLayoutPath = toPath(resolveAppModule(appDir, "layout"));
      if (depPath === rootLayoutPath) {
        await hotReloadRootLayout(projectRoot, config, routeStore);
      } else {
        await hotReloadNestedLayout(projectRoot, routeStore, depPath);
      }
    } else if (routeFilePattern.test(depPath)) {
      await hotReloadPage(projectRoot, config, routeStore, depPath);
    } else if (apiRouteFilePattern.test(depPath)) {
      await hotReloadApiRoute(projectRoot, routeStore, depPath);
    }
    // Intermediate (non-page, non-layout, non-api) dependents don't need
    // explicit handling — they are automatically re-transformed when
    // createServerModule runs recursively for the page/layout/api-route.
  }
}

// ─── Runtime Route Lifecycle Handlers ───────────────────────────────
//
// These handlers are called by the file watcher when route or layout
// files are created or deleted at runtime (without a full server
// restart). They update the mutable routeStore in-place so that the
// next request reflects the change.

/**
 * Handle a new route file (page.tsx or route.tsx) being created.
 * Builds the manifest entry, loads the module with error isolation,
 * and adds it to the route store following the same priority logic
 * as startServer's initial route loading (API routes take priority
 * over page routes at the same path).
 */
async function handleRouteFileCreated(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  try {
    const appDir = resolveAppDir(projectRoot, config);
    const kind: RouteKind = apiRouteFilePattern.test(filePath) ? "api" : "page";

    // Build the manifest entry (includes pattern, segments, params, layouts)
    const entry = buildRouteManifestEntry(appDir, filePath, kind);

    // Load the module with error isolation — same pattern as loadAppModules.
    // A broken page/api route should not crash the server; instead it gets
    // a throwing placeholder that triggers 500 when visited.
    try {
      const serverModulePath = createServerModule(projectRoot, filePath);
      const routeModule = await import(pathToFileURL(serverModulePath).href);

      if (kind === "page") {
        if (!routeModule.default) {
          console.warn(`[meiden] New page has no default export: ${filePath}`);
          entry.Page = () => {
            throw new Error(`Page missing default export: ${filePath}`);
          };
        } else {
          entry.Page = routeModule.default;
          entry.load = typeof routeModule.load === "function" ? routeModule.load : undefined;
        }
      } else {
        // API route: collect exported HTTP method handlers
        const handlers: Record<string, (ctx: ApiRouteContext) => any | Promise<any>> = {};
        for (const method of API_METHODS) {
          if (typeof routeModule[method] === "function") {
            handlers[method] = routeModule[method];
          }
        }
        if (Object.keys(handlers).length === 0) {
          console.warn(`[meiden] New API route has no HTTP method exports: ${filePath}`);
        }
        entry.handlers = handlers;
      }
    } catch (error) {
      // Import-time failure (syntax error, missing dep, etc.)
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[meiden] Failed to load new ${kind} module ${filePath}: ${message}`);
      if (kind === "page") {
        entry.Page = () => {
          throw new Error(`Failed to load page: ${message}`);
        };
      } else {
        entry.handlers = {
          GET: () => { throw new Error(`Failed to load API route: ${message}`); },
        };
      }
    }

    // Add to routesByFilePath (always, even if shadowed by another route)
    routeStore.routesByFilePath.set(filePath, entry);

    // Add to staticRoutes or dynamicRoutes with the same priority logic
    // as startServer's initial route loading: API routes take priority
    // over page routes at the same path.
    if (entry.isDynamic) {
      const existingIdx = routeStore.dynamicRoutes.findIndex(r => r.path === entry.path);
      if (existingIdx !== -1) {
        const existing = routeStore.dynamicRoutes[existingIdx];
        if (existing.kind === "page" && entry.kind === "api") {
          // API route takes priority — replace the page route
          routeStore.dynamicRoutes[existingIdx] = entry;
        }
        // If existing is API and new is page, skip (API takes priority)
      } else {
        routeStore.dynamicRoutes.push(entry);
      }
    } else {
      const existing = routeStore.staticRoutes.get(entry.path);
      if (existing) {
        if (existing.kind === "page" && entry.kind === "api") {
          // API route takes priority — replace the page route
          routeStore.staticRoutes.set(entry.path, entry);
        }
        // If existing is API and new is page, skip (API takes priority)
      } else {
        routeStore.staticRoutes.set(entry.path, entry);
      }
    }

    console.log(`[meiden] Route registered: ${entry.path} (${entry.kind})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Failed to register new route ${filePath}: ${message}`);
  }
}

/**
 * Handle a route file (page.tsx or route.tsx) being deleted.
 * Removes the entry from the route store. The route will return 404
 * after deletion.
 */
function handleRouteFileDeleted(routeStore: RouteStore, filePath: string) {
  const entry = routeStore.routesByFilePath.get(filePath);
  if (!entry) {
    console.log(`[meiden] Hot reload: deleted file ${filePath} was not a registered route`);
    return;
  }

  // Remove from routesByFilePath
  routeStore.routesByFilePath.delete(filePath);

  // Remove from staticRoutes or dynamicRoutes
  if (entry.isDynamic) {
    const idx = routeStore.dynamicRoutes.findIndex(r => r.filePath === filePath);
    if (idx !== -1) {
      routeStore.dynamicRoutes.splice(idx, 1);
    }
  } else {
    const existing = routeStore.staticRoutes.get(entry.path);
    if (existing && existing.filePath === filePath) {
      routeStore.staticRoutes.delete(entry.path);
    }
  }

  console.log(`[meiden] Route removed: ${entry.path} (${entry.kind})`);
}

/**
 * Handle a new layout file being created.
 * If it's the root layout, delegates to hotReloadRootLayout.
 * If it's a nested layout, loads the module and adds it to
 * routeStore.nestedLayouts, then updates layout chains for all
 * page routes that are children of this layout's directory.
 */
async function handleLayoutFileCreated(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  const appDir = resolveAppDir(projectRoot, config);

  // Check if this is the root layout (directly in the app directory)
  if (dirname(filePath) === appDir) {
    await hotReloadRootLayout(projectRoot, config, routeStore);
    console.log(`[meiden] Root layout created: ${filePath}`);
    return;
  }

  // Load the nested layout module with error isolation
  try {
    const serverModulePath = createServerModule(projectRoot, filePath);
    const layoutModule = await import(pathToFileURL(serverModulePath).href);

    if (!layoutModule.default) {
      console.warn(`[meiden] New nested layout has no default export: ${filePath}`);
      routeStore.nestedLayouts.set(filePath, () => {
        throw new Error(`Layout missing default export: ${filePath}`);
      });
    } else {
      routeStore.nestedLayouts.set(filePath, layoutModule.default);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Failed to load new nested layout ${filePath}: ${message}`);
    routeStore.nestedLayouts.set(filePath, () => {
      throw new Error(`Failed to load layout: ${message}`);
    });
  }

  // Update layout chains for all page routes that are children of
  // this layout's directory. resolveLayoutChain checks existsSync,
  // so it will naturally include the new layout.
  const layoutDir = dirname(filePath);
  for (const [pagePath, entry] of routeStore.routesByFilePath) {
    if (entry.kind === "page" && pagePath.startsWith(layoutDir + "/")) {
      entry.layouts = resolveLayoutChain(appDir, pagePath);
    }
  }

  console.log(`[meiden] Nested layout registered: ${filePath}`);
}

/**
 * Handle a layout file being deleted.
 * Removes it from routeStore.nestedLayouts, then updates layout chains
 * for all page routes that referenced this layout.
 * Pages that used this layout will still work but without the layout
 * wrapper — createLayoutWrapper reads from nestedLayouts at render
 * time, so removing the entry is sufficient.
 */
async function handleLayoutFileDeleted(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  const appDir = resolveAppDir(projectRoot, config);

  // Check if this is the root layout
  if (dirname(filePath) === appDir) {
    console.warn(`[meiden] Root layout deleted: ${filePath} — server may not function correctly`);
    return;
  }

  // Remove from nestedLayouts
  routeStore.nestedLayouts.delete(filePath);

  // Update layout chains for all page routes that referenced this layout.
  // Since the file has been deleted, resolveLayoutChain will naturally
  // exclude it (existsSync returns false).
  for (const [pagePath, entry] of routeStore.routesByFilePath) {
    if (entry.kind === "page" && entry.layouts.includes(filePath)) {
      entry.layouts = resolveLayoutChain(appDir, pagePath);
    }
  }

  console.log(`[meiden] Layout removed: ${filePath}`);
}

export async function startServer({ root, port = 3000 }: StartServerOptions) {
  const projectRoot = resolve(root);

  // Clean up stale generated server modules from previous dev sessions.
  // With generation-scoped cyclic paths, files accumulate rapidly across
  // HMR cascades — clearing on startup prevents .meiden/server from
  // growing unboundedly across repeated dev runs.
  const serverTmpDir = join(projectRoot, ".meiden", "server");
  if (existsSync(serverTmpDir)) {
    rmSync(serverTmpDir, { recursive: true, force: true });
  }

  const config = await loadConfig(projectRoot);
  const { RootLayout, routes: initialRoutes, nestedLayouts: initialNestedLayouts } = await loadAppModules(projectRoot, config);

  // Mutable route store — hot reload updates this in-place.
  // Route handlers read from this store instead of closing over
  // fixed values, so they always serve the latest version.
  //
  // Routes are split into static (exact path, O(1) Map lookup) and
  // dynamic (regex pattern matching) for efficient matching. The
  // routesByFilePath index enables hot reload to find the right entry
  // without scanning all routes.
  const staticRoutes = new Map<string, RouteManifestEntry>();
  const dynamicRoutes: RouteManifestEntry[] = [];
  const routesByFilePath = new Map<string, RouteManifestEntry>();

  for (const route of initialRoutes) {
    routesByFilePath.set(route.filePath, route);
    if (route.isDynamic) {
      // For dynamic routes, API routes take priority over page routes.
      // Since entries are sorted with API routes first at the same path,
      // avoid adding a page route if an API route with the same pattern
      // already exists in the array.
      const existingIdx = dynamicRoutes.findIndex(r => r.path === route.path);
      if (existingIdx === -1) {
        dynamicRoutes.push(route);
      }
      // If an API route already exists at this path, skip the page route
    } else {
      // For static routes, API routes take priority over page routes.
      // Since entries are sorted with API routes first at the same path,
      // the first entry wins — later page entries at the same path are skipped.
      if (!staticRoutes.has(route.path)) {
        staticRoutes.set(route.path, route);
      }
    }
  }

  const routeStore: RouteStore = {
    RootLayout,
    staticRoutes,
    dynamicRoutes,
    routesByFilePath,
    nestedLayouts: initialNestedLayouts,
  };

  const publicDir = join(projectRoot, "public");
  const hasPublicDir = existsSync(publicDir);

  const appDir = resolveAppDir(projectRoot, config);

  const app = new Elysia().use(html());

  // onBeforeHandle: concurrency limiter only.
  // Static file serving is handled by a catch-all route registered after
  // all page routes — Elysia only runs onBeforeHandle for matched routes,
  // so a request for /index.css that has no registered route would skip
  // onBeforeHandle entirely and get a 404. The catch-all route fixes this.
  app.onBeforeHandle(({ request, store }) => {
    // Concurrency check — reject before counting
    if (inFlightRequests >= MAX_CONCURRENT_REQUESTS) {
      const url = new URL(request.url);
      console.warn("[meiden] 503 Too Many Requests on " + url.pathname + " (concurrent limit: " + MAX_CONCURRENT_REQUESTS + ")");
      return new Response("Too Many Requests", { status: 503, headers: { "Retry-After": "1" } });
    }

    // Count this request
    inFlightRequests++;
    (store as any).__meiden_counted = true;
  });

  // Decrement only if this request was counted and not already decremented.
  app.onAfterHandle(({ store }) => {
    if ((store as any).__meiden_counted) {
      inFlightRequests--;
      (store as any).__meiden_counted = false;
    }
  });
  app.onError(({ store }) => {
    if ((store as any).__meiden_counted) {
      inFlightRequests--;
      (store as any).__meiden_counted = false;
    }
  });

  // Island runtime — always available so that pages with islands can
  // request it on demand. The HTML injection is already conditional
  // (injectIslandRuntime skips when no data-meiden-island is found),
  // but the route must exist for pages that DO have islands.
  app.get("/_meiden/islands/runtime.js", () => new Response(createIslandRuntime(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
    },
  }));

  app.get("/_meiden/islands/:source", ({ params, query }) => {
    return buildIslandModule(projectRoot, decodeURIComponent(params.source), String(query.name ?? "default"));
  });

  // Catch-all route handler — matches both static and dynamic routes for
  // both page rendering and API route handling. Instead of registering
  // each route individually with Elysia, we register a single catch-all
  // handler that uses the route manifest for matching:
  //   1. Try static routes first (O(1) Map lookup)
  //   2. Try dynamic routes by regex pattern matching
  //   3. For API routes: dispatch to the method handler (405 if missing)
  //   4. For page routes: SSR render with layouts
  //   5. Fall through to static file serving or 404
  app.all("/*", async ({ request }) => {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Try to match a route from the manifest
    const match = matchRoute(pathname, routeStore.staticRoutes, routeStore.dynamicRoutes);

    if (match) {
      const { entry, params } = match;
      const routePath = entry.path;

      // API route: dispatch to the HTTP method handler
      if (entry.kind === "api") {
        const method = request.method.toUpperCase();
        const handler = entry.handlers?.[method];

        if (!handler) {
          // Method not supported by this API route → 405 Method Not Allowed
          const allowed = Object.keys(entry.handlers ?? {}).join(", ");
          logRequest(request.method, routePath, 405, startedAt);
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: allowed },
          });
        }

        try {
          const result = await handler({ request, params });
          // If the handler returns a Response, use it directly.
          // Otherwise, JSON-encode the result.
          if (result instanceof Response) {
            logRequest(request.method, routePath, result.status, startedAt);
            return result;
          }
          logRequest(request.method, routePath, 200, startedAt);
          return Response.json(result);
        } catch (error) {
          logRequest(request.method, routePath, 500, startedAt);
          console.error(`[meiden] API error on ${routePath} ${method}:`, error);
          const message = error instanceof Error ? error.message : "Internal Server Error";
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // Page route: SSR render with layout chain
      try {
        // If the page exports a load() function, call it with the route
        // params to fetch server-side data. The result is passed as a
        // `data` prop to the page component. If load() throws, the error
        // is caught and a 500 is returned (same as SSR render errors).
        // Pages without a load() export receive undefined as data.
        let data: unknown = undefined;
        if (entry.load) {
          data = await entry.load({ params });
        }

        // Create a fresh LayoutWrapper each request using the current
        // RootLayout and nested layout components from the mutable store.
        // This ensures hot-reloaded layouts take effect immediately
        // without restarting the server.
        const CurrentLayoutWrapper = createLayoutWrapper(
          routeStore.RootLayout,
          entry.layouts,
          routeStore.nestedLayouts,
        );

        // Pass params and data as props to the Page component.
        // Static routes receive an empty params object.
        // Pages without load() receive undefined data.
        const Page = entry.Page;
        const page = <CurrentLayoutWrapper Page={Page} params={params} data={data} />;
        const html = await renderReact(projectRoot, page);
        logRequest(request.method, routePath, 200, startedAt);

        return html;
      } catch (error) {
        // Return 500 with error details instead of 200 with raw JSX
        logRequest(request.method, routePath, 500, startedAt);
        console.error("[meiden] SSR error on " + routePath + ":", error);

        const message = error instanceof Error ? error.message : "Internal Server Error";
        // Escape error message for safe HTML embedding (even in dev)
        const safeMessage = message
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
        return new Response(
          `<!DOCTYPE html><html><body><h1>500 - Server Error</h1><pre>${safeMessage}</pre></body></html>`,
          { status: 500 },
        );
      }
    }

    // No route matched — try static file serving from public/
    if (hasPublicDir) {
      const cleanPath = pathname.replace(/^\/+/, "");
      const candidateFile = resolve(publicDir, cleanPath);

      // Cross-platform path traversal check
      const rel = relative(publicDir, candidateFile);
      const isWithinPublic = rel && !rel.startsWith("..") && !isAbsolute(rel);

      if (isWithinPublic && existsSync(candidateFile) && statSync(candidateFile).isFile()) {
        return new Response(Bun.file(candidateFile), {
          headers: { "content-type": getContentType(candidateFile) },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  });

  app.listen(port);

  // ─── Hot Reload: file watcher ──────────────────────────────────────
  //
  // Watch the app directory for changes. When a page, layout, or
  // component file changes, regenerate the server module, re-import
  // it, and update the mutable routeStore. The next request will use
  // the new code.
  //
  // Component hot reload: when a non-page/layout file (e.g. a
  // component) changes, we use the dependency graph to find all
  // pages/layouts that import it (directly or transitively), then
  // re-import those modules. Because createServerModule recursively
  // transforms the entire import chain with content-hashed filenames,
  // changing a component → new component server module hash → new
  // import specifier in the page → new page server module hash →
  // Bun's import() loads fresh code.
  //
  // Route lifecycle: creating a new page/layout/API route file
  // registers it at runtime without a full server restart. Deleting
  // a route file removes it from the store so the path returns 404.
  // Deleting a layout file removes the layout wrapper from affected
  // pages while keeping them functional.
  //
  // Debouncing: file editors often trigger multiple change events
  // (write + rename, or multiple writes). We debounce by 100ms to
  // avoid redundant reloads.
  //
  // Change type detection: instead of a simple Set, we use a Map
  // that tracks whether each file was created, updated, or deleted.
  // This allows the watcher to dispatch to the correct handler:
  //   - "create": new route/layout file → register it in the store
  //   - "update": existing file changed → hot reload it
  //   - "delete": file removed → remove from store (routes 404)
  if (existsSync(appDir)) {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const changedFiles = new Map<string, "create" | "update" | "delete">();

    const watcher = watch(appDir, { recursive: true }, (event, filename) => {
      if (!filename) return;

      const filePath = join(appDir, filename);

      // Only react to source files
      if (!moduleExtensions.some(ext => filePath.endsWith(ext))) return;

      // Determine change type based on current file system state and
      // route store tracking. This is computed at collection time; the
      // debounce handler may further refine the type at processing time
      // if rapid changes occurred within the debounce window.
      if (!existsSync(filePath)) {
        changedFiles.set(filePath, "delete");
      } else {
        const isPageRoute = routeFilePattern.test(filePath) || apiRouteFilePattern.test(filePath);
        const isLayout = layoutFilePattern.test(filePath);
        const isRootLayoutFile = isLayout && dirname(filePath) === appDir;
        const isNewRoute = isPageRoute && !routeStore.routesByFilePath.has(filePath);
        const isNewLayout = isLayout && !isRootLayoutFile && !routeStore.nestedLayouts.has(filePath);

        if (isNewRoute || isNewLayout) {
          changedFiles.set(filePath, "create");
        } else {
          changedFiles.set(filePath, "update");
        }
      }

      // Debounce: collect all changed files within 100ms and reload once
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        reloadTimer = null;
        const files = [...changedFiles.entries()];
        changedFiles.clear();

        for (const [file, changeType] of files) {
          const isLayoutFile = layoutFilePattern.test(file);
          const isPageFile = routeFilePattern.test(file);
          const isApiRouteFile = apiRouteFilePattern.test(file);

          // Refine the change type at processing time to handle edge
          // cases where rapid changes occurred within the debounce window.
          let actualType = changeType;
          if (changeType === "update") {
            // File was flagged as update but might have been created and
            // updated within the debounce window ("create" event was
            // overwritten by "update"). If the route store doesn't know
            // about this file, treat it as a creation.
            if (!existsSync(file)) {
              actualType = "delete";
            } else if ((isPageFile || isApiRouteFile) && !routeStore.routesByFilePath.has(file)) {
              actualType = "create";
            } else if (isLayoutFile && dirname(file) !== appDir && !routeStore.nestedLayouts.has(file)) {
              actualType = "create";
            }
          } else if (changeType === "delete") {
            // File was flagged as delete but might have been recreated.
            if (existsSync(file)) {
              actualType = routeStore.routesByFilePath.has(file) || routeStore.nestedLayouts.has(file)
                ? "update"
                : "create";
            }
          } else if (changeType === "create") {
            // File was flagged as create but might have been quickly deleted.
            if (!existsSync(file)) {
              continue;
            }
          }

          // Dispatch to the appropriate handler based on the refined type
          if (actualType === "create") {
            if (isPageFile || isApiRouteFile) {
              await handleRouteFileCreated(projectRoot, config, routeStore, file);
            } else if (isLayoutFile) {
              await handleLayoutFileCreated(projectRoot, config, routeStore, file);
            }
            continue;
          }

          if (actualType === "delete") {
            if (isPageFile || isApiRouteFile) {
              handleRouteFileDeleted(routeStore, file);
            } else if (isLayoutFile) {
              await handleLayoutFileDeleted(projectRoot, config, routeStore, file);
            } else {
              // Component/utility file deleted — keep old module
              console.log(`[meiden] Hot reload: component deleted ${file}, keeping old module`);
            }
            continue;
          }

          // actualType === "update" — existing hot reload logic
          if (!existsSync(file)) {
            // File disappeared between collection and processing
            console.log(`[meiden] Hot reload: file disappeared ${file}`);
            continue;
          }

          if (isLayoutFile) {
            // Determine if this is the root layout or a nested layout
            const rootLayoutPath = toPath(resolveAppModule(appDir, "layout"));
            if (file === rootLayoutPath) {
              await hotReloadRootLayout(projectRoot, config, routeStore);
            } else {
              await hotReloadNestedLayout(projectRoot, routeStore, file);
            }
          } else if (isPageFile) {
            await hotReloadPage(projectRoot, config, routeStore, file);
          } else if (isApiRouteFile) {
            await hotReloadApiRoute(projectRoot, routeStore, file);
          } else {
            // Component/utility file changed — find all pages/layouts
            // that depend on it and re-import them.
            await hotReloadComponent(projectRoot, config, routeStore, file);
          }
        }
      }, 100);
    });

    // Clean up watcher when the server stops
    const originalStop = app.stop?.bind(app);
    app.stop = () => {
      watcher.close();
      originalStop?.();
    };
  }

  return app;
}
