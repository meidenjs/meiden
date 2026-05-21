import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression tests for PR #5 bug fixes:
 *   1. Dev static serving — /index.css returns 200
 *   2. No default export — server starts, bad route 500, other routes 200
 *   3. Missing config/app-dir — clear error listing tried paths
 *
 * Strategy: Create temporary projects, start the dev server on a random
 * port, make HTTP requests, then clean up.
 */

let tempRoot: string;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "meiden-regression-"));
});

afterAll(() => {
  if (tempRoot && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────

/** Symlink node_modules from the main project so React is available */
function symlinkNodeModules(projectRoot: string) {
  // Use import.meta.dir to find node_modules relative to this test file,
  // not process.cwd() which may differ depending on how bun test is invoked.
  const nmSource = join(import.meta.dir, "..", "node_modules");
  const nmTarget = join(projectRoot, "node_modules");
  if (existsSync(nmSource) && !existsSync(nmTarget)) {
    try {
      require("node:fs").symlinkSync(nmSource, nmTarget, "junction");
    } catch {
      // Symlink might fail on some platforms; continue anyway
    }
  }
}

/** Write a minimal package.json so createRequire works */
function writePackageJson(projectRoot: string) {
  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({
      name: "test-app",
      type: "module",
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
    }),
  );
}

/**
 * Start the Meiden dev server on a random port and return the base URL
 * plus the app instance for cleanup.
 */
async function startDevServer(
  projectRoot: string,
): Promise<{ baseUrl: string; app: any }> {
  const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
  const { startServer } = await import(devModulePath);
  const app = await startServer({ root: projectRoot, port: 0 });

  // Elysia stores the Bun server on app.server
  const port = app.server?.port;
  if (!port) {
    throw new Error("Dev server did not start or port is unavailable");
  }

  return { baseUrl: `http://localhost:${port}`, app };
}

/** Fetch a URL and return { status, headers, body } */
async function fetchUrl(
  url: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

// ─── Test 1: Dev Static Serving ──────────────────────────────────

describe("dev static serving regression", () => {
  it("should return 200 for /index.css from public/", async () => {
    const projectRoot = join(tempRoot, "static-serving");
    const appDir = join(projectRoot, "src", "app");
    const publicDir = join(projectRoot, "public");

    mkdirSync(appDir, { recursive: true });
    mkdirSync(publicDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Hello</h1>; }`,
    );

    // Static file in public/
    const cssContent = "body { margin: 0; }";
    writeFileSync(join(publicDir, "index.css"), cssContent);

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Request the CSS file
      const cssRes = await fetchUrl(`${baseUrl}/index.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.body).toBe(cssContent);
      expect(cssRes.headers.get("content-type")).toContain("text/css");

      // Page route should still work
      const pageRes = await fetchUrl(`${baseUrl}/`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.body).toContain("Hello");

      // Non-existent static file should 404
      const notFoundRes = await fetchUrl(`${baseUrl}/nonexistent.js`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 2: No Default Export Isolation ─────────────────────────

describe("no default export isolation regression", () => {
  it("should start server even when a page has no default export; bad route 500, other routes 200", async () => {
    const projectRoot = join(tempRoot, "no-default-export");
    const appDir = join(projectRoot, "src", "app");
    const aboutDir = join(appDir, "about");

    mkdirSync(aboutDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Valid page at /
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Broken page at /about — no default export
    writeFileSync(
      join(aboutDir, "page.tsx"),
      `export const something = "no default";`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Server should start without crashing — the broken page is isolated

      // Valid route should return 200
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      // Broken route should return 500 (page throws when rendered)
      const aboutRes = await fetchUrl(`${baseUrl}/about`);
      expect(aboutRes.status).toBe(500);
      expect(aboutRes.body).toContain("missing default export");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 3: Missing Config / App-Dir Diagnostics ────────────────

describe("missing config/app-dir diagnostics regression", () => {
  it("should throw clear error listing tried paths when no app dir or legacy files exist", async () => {
    const projectRoot = join(tempRoot, "missing-config");
    mkdirSync(projectRoot, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // No src/app, no src/layout.tsx, no src/index.tsx, no meiden.config.ts

    let thrownError: Error | null = null;
    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { startServer } = await import(devModulePath);
      await startServer({ root: projectRoot, port: 0 });
    } catch (error) {
      thrownError = error instanceof Error ? error : new Error(String(error));
    }

    rmSync(projectRoot, { recursive: true, force: true });

    expect(thrownError).not.toBeNull();
    const message = thrownError!.message;

    // Should mention "Could not find"
    expect(message).toContain("Could not find");

    // Should list the app directory path it tried
    const expectedAppDir = resolve(projectRoot, "src/app");
    expect(message).toContain(expectedAppDir);

    // Should mention legacy paths
    expect(message).toContain("layout.tsx");
    expect(message).toContain("index.tsx");
    expect(message).toContain("legacy");

    // Should suggest creating app directory or configuring meiden.config.ts
    expect(message).toContain("meiden.config");
  });
});

// ─── Test 4: Broken Import JSX Child Returns 500 ──────────────────

describe("broken import JSX child regression", () => {
  it("should return 500 when broken import is rendered as JSX child", async () => {
    const projectRoot = join(tempRoot, "broken-import-jsx-child");
    const appDir = join(projectRoot, "src", "app");
    const brokenDir = join(appDir, "broken");

    mkdirSync(brokenDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Valid page at /
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Page with broken import used as JSX child at /broken
    writeFileSync(
      join(brokenDir, "page.tsx"),
      `import Missing from "./NonExistent";

export default function Page() {
  return <div>{Missing}</div>;
}`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Valid route should return 200
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      // Broken import as JSX child should trigger 500
      // (toString/valueOf/Symbol.toPrimitive traps on the Proxy stub throw)
      const brokenRes = await fetchUrl(`${baseUrl}/broken`);
      expect(brokenRes.status).toBe(500);
      expect(brokenRes.body).toContain("Cannot resolve import");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 5: Hot Reload ──────────────────────────────────────────

describe("hot reload regression", () => {
  it("should serve updated content after page file is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "hot-reload");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Initial page content
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Content A</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request / and get Content A
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Content A");

      // Step 2: Edit page.tsx to Content B
      writeFileSync(
        join(appDir, "page.tsx"),
        `export default function Page() { return <h1>Content B</h1>; }`,
      );

      // Step 3: Wait for the file watcher to detect the change
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 4: Request / again — should get Content B
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("Content B");
      expect(resB.body).not.toContain("Content A");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 7: Circular Import ─────────────────────────────────────

describe("circular import guard regression", () => {
  it("should start server without stack overflow when components have circular imports", async () => {
    const projectRoot = join(tempRoot, "circular-import");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Component A imports B
    writeFileSync(
      join(componentsDir, "A.tsx"),
      `import B from "./B";\nexport default function A() { return <span>A</span>; }\nexport { B };`,
    );

    // Component B imports A (circular!)
    writeFileSync(
      join(componentsDir, "B.tsx"),
      `import A from "./A";\nexport default function B() { return <span>B</span>; }\nexport { A };`,
    );

    // Page imports A
    writeFileSync(
      join(appDir, "page.tsx"),
      `import A from "./components/A";\n\nexport default function Page() { return <div><A /></div>; }`,
    );

    // The server should start without infinite recursion
    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Page should render successfully (component A works)
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("A");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 9: Circular Import with Island Proxy ────────────────────

describe("circular import with island proxy regression", () => {
  it("should return a Meiden-transformed module path (not raw source) for circular imports, so island proxies are applied correctly", async () => {
    const projectRoot = join(tempRoot, "circular-import-island");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Counter is a client component (island) — uses onClick
    writeFileSync(
      join(componentsDir, "Counter.tsx"),
      `"use client";\nexport default function Counter() { return <button onClick={() => {}}>Click</button>; }`,
    );

    // Component A imports B (circular) and imports Counter (island proxy needed)
    writeFileSync(
      join(componentsDir, "A.tsx"),
      `import B from "./B";\nimport Counter from "./Counter";\nexport default function A() { return <span>A<Counter /></span>; }\nexport { B };`,
    );

    // Component B imports A (circular!)
    writeFileSync(
      join(componentsDir, "B.tsx"),
      `import A from "./A";\nexport default function B() { return <span>B</span>; }\nexport { A };`,
    );

    // Page imports A (which triggers A→B→A cycle + island proxy for Counter)
    writeFileSync(
      join(appDir, "page.tsx"),
      `import A from "./components/A";\n\nexport default function Page() { return <div><A /></div>; }`,
    );

    // The server should start without infinite recursion and the
    // circular reference should point to a Meiden-transformed module
    // (with `import React` prepended and island proxies rewritten),
    // not the raw source.
    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      // A should render
      expect(res.body).toContain("A");
      // The Counter island should render with its data-meiden-island attribute
      // (this verifies the cyclic reference B→A used the transformed module,
      // not the raw source which wouldn't have island proxies)
      expect(res.body).toContain("data-meiden-island");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 8: Shared Dependency (not treated as circular) ─────────

describe("shared dependency not treated as circular regression", () => {
  it("should correctly handle shared dependencies: A→Shared, B→Shared should not be flagged as circular", async () => {
    const projectRoot = join(tempRoot, "shared-dependency");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Shared component (imported by both A and B)
    writeFileSync(
      join(componentsDir, "Shared.tsx"),
      `export default function Shared() { return <span>Shared</span>; }`,
    );

    // Component A imports Shared
    writeFileSync(
      join(componentsDir, "A.tsx"),
      `import Shared from "./Shared";\nexport default function A() { return <span>A<Shared /></span>; }`,
    );

    // Component B also imports Shared (not circular — just a shared dependency)
    writeFileSync(
      join(componentsDir, "B.tsx"),
      `import Shared from "./Shared";\nexport default function B() { return <span>B<Shared /></span>; }`,
    );

    // Page imports both A and B
    writeFileSync(
      join(appDir, "page.tsx"),
      `import A from "./components/A";\nimport B from "./components/B";\n\nexport default function Page() { return <div><A /><B /></div>; }`,
    );

    // The server should start without errors — Shared must not be
    // treated as circular just because A and B both import it.
    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("A");
      expect(res.body).toContain("B");
      expect(res.body).toContain("Shared");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 6: Component Hot Reload ────────────────────────────────

describe("component hot reload regression", () => {
  it("should serve updated content after an imported component is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "component-hot-reload");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Component: Message.tsx (initially renders "Hello A")
    writeFileSync(
      join(componentsDir, "Message.tsx"),
      `export default function Message() { return <span>Hello A</span>; }`,
    );

    // Page imports Message component
    writeFileSync(
      join(appDir, "page.tsx"),
      `import Message from "./components/Message";\n\nexport default function Page() { return <div><Message /></div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request / and see "Hello A"
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Hello A");

      // Step 2: Edit Message.tsx to render "Hello B"
      writeFileSync(
        join(componentsDir, "Message.tsx"),
        `export default function Message() { return <span>Hello B</span>; }`,
      );

      // Step 3: Wait for the file watcher to detect the component change
      // and propagate it through the dependency graph
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request / again — should see "Hello B" without restart
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("Hello B");
      expect(resB.body).not.toContain("Hello A");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 10: Circular Import Hot Reload (content-scoped versioning) ─

describe("circular import hot reload regression", () => {
  it("should serve updated content after a circular-import component is modified (ESM cache busted)", async () => {
    const projectRoot = join(tempRoot, "circular-import-hmr");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Component A imports B (circular)
    writeFileSync(
      join(componentsDir, "A.tsx"),
      `import B from "./B";\nexport default function A() { return <span>Version1</span>; }\nexport { B };`,
    );

    // Component B imports A (circular!)
    writeFileSync(
      join(componentsDir, "B.tsx"),
      `import A from "./A";\nexport default function B() { return <span>B</span>; }\nexport { A };`,
    );

    // Page imports A
    writeFileSync(
      join(appDir, "page.tsx"),
      `import A from "./components/A";\n\nexport default function Page() { return <div><A /></div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Initial request — should render Version1
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Version1");

      // Step 2: Edit A.tsx to render Version2
      writeFileSync(
        join(componentsDir, "A.tsx"),
        `import B from "./B";\nexport default function A() { return <span>Version2</span>; }\nexport { B };`,
      );

      // Step 3: Wait for the file watcher to detect the change
      // and propagate it through the dependency graph
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request / again — should render Version2
      // This verifies that the content-scoped deterministic path
      // (which includes the source hash) busts Bun's ESM cache
      // for the cyclic reference B→A. Without content-scoped
      // versioning, the deterministic path `route-${hash(realPath)}.tsx`
      // would be stable across edits and Bun would return stale code.
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("Version2");
      expect(resB.body).not.toContain("Version1");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 11: Island / Client Component Hot Reload ──────────────────

describe("island/client component hot reload regression", () => {
  it("should serve updated content after a use client component is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "island-hot-reload");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Client component (island) — initially renders "Count: 0"
    writeFileSync(
      join(componentsDir, "Counter.tsx"),
      `"use client";\nexport default function Counter() { return <button onClick={() => {}}>Count: 0</button>; }`,
    );

    // Page imports the client component
    writeFileSync(
      join(appDir, "page.tsx"),
      `import Counter from "./components/Counter";\n\nexport default function Page() { return <div><Counter /></div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request / and see the island rendered with "Count: 0"
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Count: 0");
      // Verify it was identified as an island
      expect(resA.body).toContain("data-meiden-island");

      // Step 2: Edit Counter.tsx to render "Count: 1"
      writeFileSync(
        join(componentsDir, "Counter.tsx"),
        `"use client";\nexport default function Counter() { return <button onClick={() => {}}>Count: 1</button>; }`,
      );

      // Step 3: Wait for the file watcher to detect the change
      // and propagate it through the dependency graph
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request / again — should see "Count: 1" without restart.
      // This verifies that the page→island dependency edge was registered
      // so findDependents() can find the page and re-import it.
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("Count: 1");
      expect(resB.body).not.toContain("Count: 0");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 12: Island Nested Dependency Hot Reload ──────────────────

describe("island nested dependency hot reload regression", () => {
  it("should serve updated content when a nested dependency of a use client component is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "island-nested-hmr");
    const appDir = join(projectRoot, "src", "app");
    const componentsDir = join(appDir, "components");

    mkdirSync(componentsDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Non-client label component — initially renders "Label A"
    writeFileSync(
      join(componentsDir, "Label.tsx"),
      `export default function Label() { return <span>Label A</span>; }`,
    );

    // Client component (island) imports Label
    writeFileSync(
      join(componentsDir, "Counter.tsx"),
      `"use client";\nimport Label from "./Label";\nexport default function Counter() { return <button onClick={() => {}}><Label /></button>; }`,
    );

    // Page imports the client component
    writeFileSync(
      join(appDir, "page.tsx"),
      `import Counter from "./components/Counter";\n\nexport default function Page() { return <div><Counter /></div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request / and see the island rendered with "Label A"
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Label A");
      expect(resA.body).toContain("data-meiden-island");

      // Step 2: Edit Label.tsx (nested dependency) to render "Label B"
      writeFileSync(
        join(componentsDir, "Label.tsx"),
        `export default function Label() { return <span>Label B</span>; }`,
      );

      // Step 3: Wait for the file watcher to detect the change
      // and propagate it through the dependency graph
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request / again — should see "Label B" without restart.
      // This verifies that the island's nested dependencies are
      // content-hashed through createServerModule(), so changes to
      // Label.tsx propagate: Label hash changes → Counter server module
      // hash changes → proxy hash changes → page hash changes → fresh code.
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("Label B");
      expect(resB.body).not.toContain("Label A");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 13: Dynamic Route [slug] ──────────────────────────────────

describe("dynamic route [slug] regression", () => {
  it("should match /blog/[slug] and pass params to the page component", async () => {
    const projectRoot = join(tempRoot, "dynamic-route-slug");
    const appDir = join(projectRoot, "src", "app");
    const blogSlugDir = join(appDir, "blog", "[slug]");

    mkdirSync(blogSlugDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Static home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Dynamic blog page — renders the slug param
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <article>Post: {params.slug}</article>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Static route still works
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      // Dynamic route /blog/hello-world should match and pass slug param
      const slugRes = await fetchUrl(`${baseUrl}/blog/hello-world`);
      expect(slugRes.status).toBe(200);
      expect(slugRes.body).toContain("hello-world");
      expect(slugRes.body).toContain("Post:");

      // Another slug value
      const slugRes2 = await fetchUrl(`${baseUrl}/blog/meiden-framework`);
      expect(slugRes2.status).toBe(200);
      expect(slugRes2.body).toContain("meiden-framework");

      // Non-matching path should 404
      const notFoundRes = await fetchUrl(`${baseUrl}/blog`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 14: Dynamic Route [...path] (catch-all) ──────────────────

describe("dynamic route [...path] catch-all regression", () => {
  it("should match /docs/[...path] and pass multi-segment path param", async () => {
    const projectRoot = join(tempRoot, "dynamic-route-wildcard");
    const appDir = join(projectRoot, "src", "app");
    const docsCatchAllDir = join(appDir, "docs", "[...path]");

    mkdirSync(docsCatchAllDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Static home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Catch-all docs page — renders the full path
    writeFileSync(
      join(docsCatchAllDir, "page.tsx"),
      `export default function DocsPage({ params }: { params: { path: string } }) { return <div>Docs: {params.path}</div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Single-segment catch-all
      const singleRes = await fetchUrl(`${baseUrl}/docs/getting-started`);
      expect(singleRes.status).toBe(200);
      expect(singleRes.body).toContain("getting-started");
      expect(singleRes.body).toContain("Docs:");

      // Multi-segment catch-all
      const multiRes = await fetchUrl(`${baseUrl}/docs/api/reference/routes`);
      expect(multiRes.status).toBe(200);
      expect(multiRes.body).toContain("api/reference/routes");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 15: Static Route Priority Over Dynamic ────────────────────

describe("static route priority over dynamic regression", () => {
  it("should match static /blog/archive before dynamic /blog/[slug]", async () => {
    const projectRoot = join(tempRoot, "static-priority");
    const appDir = join(projectRoot, "src", "app");
    const blogSlugDir = join(appDir, "blog", "[slug]");
    const blogArchiveDir = join(appDir, "blog", "archive");

    mkdirSync(blogSlugDir, { recursive: true });
    mkdirSync(blogArchiveDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Static home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Dynamic blog slug page
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <article>Slug: {params.slug}</article>; }`,
    );

    // Static archive page — should take priority over [slug]
    writeFileSync(
      join(blogArchiveDir, "page.tsx"),
      `export default function ArchivePage() { return <div>Archive</div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // /blog/archive should match the static route, NOT [slug]
      const archiveRes = await fetchUrl(`${baseUrl}/blog/archive`);
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body).toContain("Archive");
      expect(archiveRes.body).not.toContain("article"); // dynamic page uses <article>

      // /blog/other should match the dynamic [slug] route
      const slugRes = await fetchUrl(`${baseUrl}/blog/my-post`);
      expect(slugRes.status).toBe(200);
      expect(slugRes.body).toContain("my-post");
      expect(slugRes.body).toContain("Slug:");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 16: Multiple Dynamic Segments ─────────────────────────────

describe("multiple dynamic segments regression", () => {
  it("should match /user/[id]/post/[postId] and pass both params", async () => {
    const projectRoot = join(tempRoot, "multi-dynamic-segments");
    const appDir = join(projectRoot, "src", "app");
    const userPostDir = join(appDir, "user", "[id]", "post", "[postId]");

    mkdirSync(userPostDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Multi-param page
    writeFileSync(
      join(userPostDir, "page.tsx"),
      `export default function UserPost({ params }: { params: { id: string; postId: string } }) { return <div>User {params.id} Post {params.postId}</div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/user/42/post/7`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("42");
      expect(res.body).toContain("7");
      expect(res.body).toContain("User");
      expect(res.body).toContain("Post");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
