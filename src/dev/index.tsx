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

// ─── Constants ──────────────────────────────────────────────────────

const moduleExtensions = [".tsx", ".ts", ".jsx", ".js"];
const configExtensions = [".ts", ".js", ".mjs", ".mts", ".cjs"];
const routeFilePattern = /(^|\/)page\.(tsx|ts|jsx|js)$/;

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
  const absolutePath = escapeJsString(sourcePath.replaceAll("\\", "/"));

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
    routes: [{ path: "/", Page: indexModule.default, filePath: "src/index" }],
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
  const routeFiles = scanAppRoutes(appDir);

  if (!layoutModule.default || routeFiles.length === 0) {
    throw new Error("Meiden app router projects must export src/app/layout and at least one page.");
  }

  // Load each route module in isolation — a broken page should not
  // kill the entire server. Failed routes get an error-page component
  // that renders a 500 when visited.
  const routes = await Promise.all(
    routeFiles.map(async (filePath) => {
      const routePath = toRoutePath(appDir, filePath);

      try {
        const pageModule = await import(pathToFileURL(createServerModule(root, filePath)).href);

        if (!pageModule.default) {
          console.warn(`[meiden] Page has no default export: ${filePath}`);
          return {
            path: routePath,
            Page: () => {
              throw new Error(`Page missing default export: ${filePath}`);
            },
            filePath,
          };
        }

        return {
          path: routePath,
          Page: pageModule.default,
          filePath,
        };
      } catch (error) {
        // Import-time failure (syntax error, missing dep, etc.)
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[meiden] Failed to load page module ${filePath}: ${message}`);
        return {
          path: routePath,
          Page: () => {
            throw new Error(`Failed to load page: ${message}`);
          },
          filePath,
        };
      }
    }),
  );

  return {
    RootLayout: layoutModule.default,
    routes,
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

export function createLayoutWrapper(RootLayout: AppModules["RootLayout"]) {
  return function LayoutWrapper({ Page }: LayoutWrapperProps): any {
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

  // Build a lightweight static file server
  await buildStaticServer(outputRoot, routes);

  return {
    outDir: outputRoot,
    routes: routes.length,
    islands: islands.size,
    assets: assets.sort((a, b) => b.size - a.size),
  };
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
 */
interface RouteStore {
  RootLayout: Component<{ children: unknown }>;
  routes: Map<string, AppRoute>; // path → route (for O(1) lookup)
}

/**
 * Hot-reload a single page module. Regenerates the server module,
 * re-imports it, and updates the route store. Errors are logged but
 * do not crash the server — the old route stays active until the
 * broken file is fixed.
 */
async function hotReloadPage(
  projectRoot: string,
  config: MeidenConfig,
  routeStore: RouteStore,
  filePath: string,
) {
  const appDir = resolveAppDir(projectRoot, config);
  const routePath = toRoutePath(appDir, filePath);

  try {
    const serverModulePath = createServerModule(projectRoot, filePath);
    const pageModule = await import(pathToFileURL(serverModulePath).href);

    if (!pageModule.default) {
      console.warn(`[meiden] Hot reload: page has no default export: ${filePath}`);
      routeStore.routes.set(routePath, {
        path: routePath,
        Page: () => {
          throw new Error(`Page missing default export: ${filePath}`);
        },
        filePath,
      });
      return;
    }

    routeStore.routes.set(routePath, {
      path: routePath,
      Page: pageModule.default,
      filePath,
    });
    console.log(`[meiden] Hot reload: ${routePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for ${filePath}: ${message}`);
    // Keep the old route active — don't break the server
  }
}

/**
 * Hot-reload the layout module. Regenerates the server module,
 * re-imports it, and updates the route store's RootLayout.
 */
async function hotReloadLayout(
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
      console.error("[meiden] Hot reload: layout has no default export — keeping old layout");
      return;
    }

    routeStore.RootLayout = layoutModule.default;
    console.log("[meiden] Hot reload: layout");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meiden] Hot reload failed for layout: ${message}`);
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

  const layoutPattern = /(^|\/)layout\.(tsx|ts|jsx|js)$/;

  for (const depPath of dependents) {
    if (!existsSync(depPath)) continue;

    if (layoutPattern.test(depPath)) {
      await hotReloadLayout(projectRoot, config, routeStore);
    } else if (routeFilePattern.test(depPath)) {
      await hotReloadPage(projectRoot, config, routeStore, depPath);
    }
    // Intermediate (non-page, non-layout) dependents don't need
    // explicit handling — they are automatically re-transformed when
    // createServerModule runs recursively for the page/layout.
  }
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
  const { RootLayout, routes: initialRoutes } = await loadAppModules(projectRoot, config);

  // Mutable route store — hot reload updates this in-place.
  // Route handlers read from this store instead of closing over
  // fixed values, so they always serve the latest version.
  const routeStore: RouteStore = {
    RootLayout,
    routes: new Map(initialRoutes.map(r => [r.path, r])),
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

  // Register routes that read from the mutable routeStore.
  // When hot reload updates routeStore, the next request will
  // automatically use the new module without re-registering routes.
  for (const route of initialRoutes) {
    app.get(route.path, async ({ request, set }) => {
      const startedAt = performance.now();
      // Look up the latest version of this route from the store
      const currentRoute = routeStore.routes.get(route.path) ?? route;

      try {
        // Create a fresh LayoutWrapper each request using the current RootLayout
        // from the mutable store. This ensures hot-reloaded layouts take effect
        // immediately without restarting the server.
        const CurrentLayoutWrapper = createLayoutWrapper(routeStore.RootLayout);
        const page = <CurrentLayoutWrapper Page={currentRoute.Page} />;
        const html = await renderReact(projectRoot, page);
        logRequest(request.method, route.path, 200, startedAt);

        return html;
      } catch (error) {
        // Return 500 with error details instead of 200 with raw JSX
        logRequest(request.method, route.path, 500, startedAt);
        console.error("[meiden] SSR error on " + route.path + ":", error);

        set.status = 500;
        const message = error instanceof Error ? error.message : "Internal Server Error";
        // Escape error message for safe HTML embedding (even in dev)
        const safeMessage = message
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
        return `<!DOCTYPE html><html><body><h1>500 - Server Error</h1><pre>${safeMessage}</pre></body></html>`;
      }
    });
  }

  // Catch-all route: serve static files from public/, or return 404.
  // This MUST be registered after all page routes so that specific routes
  // take priority. Elysia's onBeforeHandle only fires for matched routes,
  // so a request like /index.css (which has no registered route) would
  // previously skip the middleware and get a 404. The catch-all ensures
  // every request matches at least one route, so the concurrency counter
  // and static file serving both work correctly.
  app.get("/*", ({ request }) => {
    if (hasPublicDir) {
      const url = new URL(request.url);
      const pathname = url.pathname;
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
  // Debouncing: file editors often trigger multiple change events
  // (write + rename, or multiple writes). We debounce by 100ms to
  // avoid redundant reloads.
  //
  // Limitations:
  //   - Adding a new route while the server is running does NOT
  //     register it (routes are only scanned at startup).
  //   - Deleting a route file keeps the old route active.
  //   - Only editing existing routes/components triggers hot reload.
  if (existsSync(appDir)) {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const changedFiles = new Set<string>();

    const layoutPattern = /(^|\/)layout\.(tsx|ts|jsx|js)$/;

    const watcher = watch(appDir, { recursive: true }, (event, filename) => {
      if (!filename) return;

      const filePath = join(appDir, filename);

      // Only react to source files
      if (!moduleExtensions.some(ext => filePath.endsWith(ext))) return;

      // All source files in appDir are watched — pages, layouts,
      // components, utilities. Component changes are resolved via
      // the dependency graph.
      changedFiles.add(filePath);

      // Debounce: collect all changed files within 100ms and reload once
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        reloadTimer = null;
        const files = [...changedFiles];
        changedFiles.clear();

        for (const file of files) {
          if (!existsSync(file)) {
            // File was deleted — skip (route stays with old module)
            console.log(`[meiden] Hot reload: file deleted ${file}, keeping old module`);
            continue;
          }

          const isLayoutFile = layoutPattern.test(file);
          const isPageFile = routeFilePattern.test(file);

          if (isLayoutFile) {
            await hotReloadLayout(projectRoot, config, routeStore);
          } else if (isPageFile) {
            await hotReloadPage(projectRoot, config, routeStore, file);
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
