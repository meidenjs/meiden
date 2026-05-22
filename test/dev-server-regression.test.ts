import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
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
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(url, init);
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

// ─── Test 17: URL-Encoded Params ────────────────────────────────────

describe("URL-encoded params regression", () => {
  it("should URL-decode params before passing to page components", async () => {
    const projectRoot = join(tempRoot, "url-encoded-params");
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

    // Page that renders the decoded slug with clear delimiters
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <span>SLUG:{params.slug}:END</span>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Space encoding: %20 → should decode to space
      const spaceRes = await fetchUrl(`${baseUrl}/blog/hello%20world`);
      expect(spaceRes.status).toBe(200);
      expect(spaceRes.body).toContain("hello world");
      expect(spaceRes.body).not.toContain("hello%20world");

      // Plus sign: %2B → should decode to +
      const plusRes = await fetchUrl(`${baseUrl}/blog/1%2B1`);
      expect(plusRes.status).toBe(200);
      expect(plusRes.body).toContain("1+1");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 19: Malformed Percent-Encoded Params ─────────────────────

describe("malformed percent-encoded params regression", () => {
  it("should return 404 for malformed percent-encoded URL params (no unhandled throw)", async () => {
    const projectRoot = join(tempRoot, "malformed-encoding");
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

    // Dynamic blog page
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <span>Slug:{params.slug}</span>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Valid encoded param should still work
      const validRes = await fetchUrl(`${baseUrl}/blog/hello%20world`);
      expect(validRes.status).toBe(200);
      expect(validRes.body).toContain("hello world");

      // Malformed percent-encoding: %E0%A4%A is an incomplete UTF-8 sequence
      // This should NOT throw an unhandled error — instead it should return 404
      // because safeDecodeParam returns null → matchRoute returns undefined
      const malformedRes = await fetchUrl(`${baseUrl}/blog/%E0%A4%A`);
      expect(malformedRes.status).toBe(404);

      // Another malformed case: lone percent sign
      const lonePercentRes = await fetchUrl(`${baseUrl}/blog/test%`);
      expect(lonePercentRes.status).toBe(404);

      // Valid encoding should still work after malformed attempts
      const validAgainRes = await fetchUrl(`${baseUrl}/blog/valid-slug`);
      expect(validAgainRes.status).toBe(200);
      expect(validAgainRes.body).toContain("valid-slug");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 18: [...path] requires at least one segment ───────────────

describe("catch-all [...path] requires at least one segment regression", () => {
  it("should NOT match /docs for /docs/[...path] (requires at least one segment)", async () => {
    const projectRoot = join(tempRoot, "catchall-required");
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

    // Catch-all docs page
    writeFileSync(
      join(docsCatchAllDir, "page.tsx"),
      `export default function DocsPage({ params }: { params: { path: string } }) { return <div>Path:{params.path}</div>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // /docs without a segment should NOT match [...path]
      const noSegmentRes = await fetchUrl(`${baseUrl}/docs`);
      expect(noSegmentRes.status).toBe(404);

      // /docs/getting-started should match (one segment)
      const oneSegmentRes = await fetchUrl(`${baseUrl}/docs/getting-started`);
      expect(oneSegmentRes.status).toBe(200);
      expect(oneSegmentRes.body).toContain("getting-started");

      // /docs/a/b/c should match (multi-segment)
      const multiSegmentRes = await fetchUrl(`${baseUrl}/docs/a/b/c`);
      expect(multiSegmentRes.status).toBe(200);
      expect(multiSegmentRes.body).toContain("a/b/c");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 20: Root Layout Only (no nested) ──────────────────────────

describe("root layout only regression", () => {
  it("should still work with only root layout (no nested layouts)", async () => {
    const projectRoot = join(tempRoot, "root-layout-only");
    const appDir = join(projectRoot, "src", "app");
    const aboutDir = join(appDir, "about");

    mkdirSync(aboutDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout with distinctive marker
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div class="root">{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // About page (no layout.tsx in about/)
    writeFileSync(
      join(aboutDir, "page.tsx"),
      `export default function Page() { return <h1>About</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("root");
      expect(homeRes.body).toContain("Home");

      const aboutRes = await fetchUrl(`${baseUrl}/about`);
      expect(aboutRes.status).toBe(200);
      expect(aboutRes.body).toContain("root");
      expect(aboutRes.body).toContain("About");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 21: Nested Layout Wraps Page ──────────────────────────────

describe("nested layout wraps page regression", () => {
  it("should wrap page with nested layout (RootLayout > BlogLayout > Page)", async () => {
    const projectRoot = join(tempRoot, "nested-layout-wrap");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const blogSlugDir = join(blogDir, "[slug]");

    mkdirSync(blogSlugDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div class="root">{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Blog nested layout
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children }: { children: any }) { return <section class="blog">{children}</section>; }`,
    );

    // Blog post page
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <article>Post:{params.slug}</article>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Home page should only have root layout
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("root");
      expect(homeRes.body).toContain("Home");
      expect(homeRes.body).not.toContain("blog");

      // Blog page should have BOTH root layout and blog layout
      const blogRes = await fetchUrl(`${baseUrl}/blog/hello`);
      expect(blogRes.status).toBe(200);
      expect(blogRes.body).toContain("root");
      expect(blogRes.body).toContain("blog");
      expect(blogRes.body).toContain("hello");
      expect(blogRes.body).toContain("Post:");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 22: Multiple Nested Layouts Render in Correct Order ──────

describe("multiple nested layouts render in correct order regression", () => {
  it("should render RootLayout > BlogLayout > SlugLayout > Page in correct nesting order", async () => {
    const projectRoot = join(tempRoot, "multi-nested-layouts");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const blogSlugDir = join(blogDir, "[slug]");

    mkdirSync(blogSlugDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout wraps with <div class="root">
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div class="root">{children}</div>; }`,
    );

    // Blog layout wraps with <section class="blog">
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children }: { children: any }) { return <section class="blog">{children}</section>; }`,
    );

    // Slug layout wraps with <span class="slug-wrapper">
    writeFileSync(
      join(blogSlugDir, "layout.tsx"),
      `export default function SlugLayout({ children }: { children: any }) { return <span class="slug-wrapper">{children}</span>; }`,
    );

    // Blog post page
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em>{params.slug}</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/blog/test-post`);
      expect(res.status).toBe(200);

      // Verify all layouts are present
      expect(res.body).toContain("root");
      expect(res.body).toContain("blog");
      expect(res.body).toContain("slug-wrapper");
      expect(res.body).toContain("test-post");

      // Verify nesting order: root > blog > slug-wrapper > em
      // In SSR HTML, the outermost element appears first
      const rootIdx = res.body.indexOf("root");
      const blogIdx = res.body.indexOf("blog");
      const slugIdx = res.body.indexOf("slug-wrapper");
      const postIdx = res.body.indexOf("test-post");
      expect(rootIdx).toBeLessThan(blogIdx);
      expect(blogIdx).toBeLessThan(slugIdx);
      expect(slugIdx).toBeLessThan(postIdx);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 23: Dynamic Route with Nested Layout Gets Params ──────────

describe("dynamic route with nested layout gets params regression", () => {
  it("should pass params to page through nested layout", async () => {
    const projectRoot = join(tempRoot, "dynamic-nested-layout-params");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const blogSlugDir = join(blogDir, "[slug]");

    mkdirSync(blogSlugDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Blog nested layout
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children }: { children: any }) { return <section>{children}</section>; }`,
    );

    // Blog post page — uses params
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em>SLUG:{params.slug}:END</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // URL-encoded param should be decoded and passed through layout
      const res = await fetchUrl(`${baseUrl}/blog/hello%20world`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("SLUG:");
      expect(res.body).toContain("hello world");
      expect(res.body).toContain(":END");
      expect(res.body).not.toContain("hello%20world");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 24: Hot Reload Nested Layout Updates Without Restart ──────

describe("nested layout hot reload regression", () => {
  it("should serve updated content after nested layout is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "nested-layout-hmr");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const blogSlugDir = join(blogDir, "[slug]");

    mkdirSync(blogSlugDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Blog nested layout — initially renders "BlogV1"
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children }: { children: any }) { return <section>BlogV1:{children}</section>; }`,
    );

    // Blog post page
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em>{params.slug}</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Initial request — should see BlogV1
      const resA = await fetchUrl(`${baseUrl}/blog/test`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("BlogV1");
      expect(resA.body).toContain("test");

      // Step 2: Edit the nested layout to BlogV2
      writeFileSync(
        join(blogDir, "layout.tsx"),
        `export default function BlogLayout({ children }: { children: any }) { return <section>BlogV2:{children}</section>; }`,
      );

      // Step 3: Wait for file watcher
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request again — should see BlogV2
      const resB = await fetchUrl(`${baseUrl}/blog/test`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("BlogV2");
      expect(resB.body).not.toContain("BlogV1");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 25: Broken Nested Layout Does Not Crash Unrelated Routes ──

describe("broken nested layout isolation regression", () => {
  it("should return 500 for routes using broken nested layout but 200 for unaffected routes", async () => {
    const projectRoot = join(tempRoot, "broken-nested-layout");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const blogSlugDir = join(blogDir, "[slug]");
    const aboutDir = join(appDir, "about");

    mkdirSync(blogSlugDir, { recursive: true });
    mkdirSync(aboutDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page (no nested layout)
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Blog nested layout — BROKEN (no default export)
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export const broken = true;`,
    );

    // Blog post page (uses broken layout)
    writeFileSync(
      join(blogSlugDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em>{params.slug}</em>; }`,
    );

    // About page (no nested layout, should be unaffected)
    writeFileSync(
      join(aboutDir, "page.tsx"),
      `export default function Page() { return <h1>About</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Home page should work fine (no nested layout)
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      // About page should work fine (no nested layout)
      const aboutRes = await fetchUrl(`${baseUrl}/about`);
      expect(aboutRes.status).toBe(200);
      expect(aboutRes.body).toContain("About");

      // Blog page should 500 (broken nested layout)
      const blogRes = await fetchUrl(`${baseUrl}/blog/test`);
      expect(blogRes.status).toBe(500);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 26: API Route GET Handler ─────────────────────────────────

describe("API route GET handler regression", () => {
  it("should handle GET requests to API routes and return JSON", async () => {
    const projectRoot = join(tempRoot, "api-route-get");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "hello");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route at /api/hello
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return { message: "Hello from API" }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // API route should return JSON
      const apiRes = await fetchUrl(`${baseUrl}/api/hello`);
      expect(apiRes.status).toBe(200);
      expect(apiRes.body).toContain("Hello from API");
      expect(apiRes.headers.get("content-type")).toContain("application/json");

      // Page route should still work
      const pageRes = await fetchUrl(`${baseUrl}/`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.body).toContain("Home");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 27: API Route POST Handler ────────────────────────────────

describe("API route POST handler regression", () => {
  it("should handle POST requests to API routes", async () => {
    const projectRoot = join(tempRoot, "api-route-post");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "items");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route with GET and POST
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return { items: [] }; }\nexport async function POST({ request }: { request: Request }) { const body = await request.json(); return { created: body }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // GET should return empty list
      const getRes = await fetchUrl(`${baseUrl}/api/items`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toContain("items");

      // POST should echo the body
      const postRes = await fetchUrl(`${baseUrl}/api/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Item" }),
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body).toContain("Test Item");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 28: API Route 405 Method Not Allowed ──────────────────────

describe("API route 405 method not allowed regression", () => {
  it("should return 405 for unsupported HTTP methods on API routes", async () => {
    const projectRoot = join(tempRoot, "api-route-405");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "readonly");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route with only GET
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return { data: "read-only" }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // GET should work
      const getRes = await fetchUrl(`${baseUrl}/api/readonly`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toContain("read-only");

      // POST should return 405
      const postRes = await fetchUrl(`${baseUrl}/api/readonly`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(postRes.status).toBe(405);
      expect(postRes.headers.get("Allow")).toContain("GET");

      // DELETE should also return 405
      const deleteRes = await fetchUrl(`${baseUrl}/api/readonly`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(405);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 29: API Route with Dynamic Params ─────────────────────────

describe("API route with dynamic params regression", () => {
  it("should pass URL params to API route handlers", async () => {
    const projectRoot = join(tempRoot, "api-route-params");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "users", "[id]");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route with dynamic param
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET({ params }: { params: { id: string } }) { return { userId: params.id, name: "User " + params.id }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/api/users/42`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("42");
      expect(res.body).toContain("User 42");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 30: API Route Priority Over Page at Same Path ─────────────

describe("API route priority over page regression", () => {
  it("should serve API route instead of page when both exist at same path", async () => {
    const projectRoot = join(tempRoot, "api-route-priority");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "data");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Page at /api/data
    writeFileSync(
      join(apiDir, "page.tsx"),
      `export default function DataPage() { return <div>Data Page</div>; }`,
    );

    // API route at /api/data
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return { api: true, data: "from-api" }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // /api/data should return API route, not page
      const res = await fetchUrl(`${baseUrl}/api/data`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.body).toContain("from-api");
      expect(res.body).not.toContain("Data Page");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 31: API Route Returns Custom Response ──────────────────────

describe("API route custom response regression", () => {
  it("should return custom Response objects from API handlers directly", async () => {
    const projectRoot = join(tempRoot, "api-route-custom-response");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "custom");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route returning custom Response
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return new Response("Plain text response", { status: 200, headers: { "Content-Type": "text/plain" } }); }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/api/custom`);
      expect(res.status).toBe(200);
      expect(res.body).toBe("Plain text response");
      expect(res.headers.get("content-type")).toContain("text/plain");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test 32: API Route Hot Reload ──────────────────────────────────

describe("API route hot reload regression", () => {
  it("should serve updated API response after route file is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "api-route-hot-reload");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "version");

    mkdirSync(apiDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // API route — initially returns v1
    writeFileSync(
      join(apiDir, "route.ts"),
      `export function GET() { return { version: "v1" }; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request API and get v1
      const resA = await fetchUrl(`${baseUrl}/api/version`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("v1");

      // Step 2: Edit route.ts to v2
      writeFileSync(
        join(apiDir, "route.ts"),
        `export function GET() { return { version: "v2" }; }`,
      );

      // Step 3: Wait for file watcher
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: Request again — should get v2
      const resB = await fetchUrl(`${baseUrl}/api/version`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("v2");
      expect(resB.body).not.toContain("v1");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#12: Runtime Page Route Creation ───────────────────────

describe("runtime page route creation regression", () => {
  it("should register a new page route at runtime when a page.tsx file is created (no restart)", async () => {
    const projectRoot = join(tempRoot, "route-create-page");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Create about directory before startup so the watcher can detect
    // files created in it (some platforms don't fire events for newly
    // created directories)
    const aboutDir = join(appDir, "about");
    mkdirSync(aboutDir, { recursive: true });

    // Only home page at startup
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: /about should 404 (not yet created)
      const beforeRes = await fetchUrl(`${baseUrl}/about`);
      expect(beforeRes.status).toBe(404);

      // Step 2: Create about/page.tsx at runtime
      writeFileSync(
        join(aboutDir, "page.tsx"),
        `export default function Page() { return <h1>About Page</h1>; }`,
      );

      // Step 3: Wait for the file watcher to detect the new file
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: /about should now return 200 with the new page
      const afterRes = await fetchUrl(`${baseUrl}/about`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body).toContain("About Page");

      // Home page should still work
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#12: Runtime Page Route Deletion ───────────────────────

describe("runtime page route deletion regression", () => {
  it("should return 404 for a deleted page route at runtime (no restart)", async () => {
    const projectRoot = join(tempRoot, "route-delete-page");
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

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // About page
    writeFileSync(
      join(aboutDir, "page.tsx"),
      `export default function Page() { return <h1>About Page</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: /about should return 200
      const beforeRes = await fetchUrl(`${baseUrl}/about`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body).toContain("About Page");

      // Step 2: Delete about/page.tsx
      unlinkSync(join(aboutDir, "page.tsx"));

      // Step 3: Wait for the file watcher to detect the deletion
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 4: /about should now return 404
      const afterRes = await fetchUrl(`${baseUrl}/about`);
      expect(afterRes.status).toBe(404);

      // Home page should still work
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#12: Runtime API Route Creation ────────────────────────

describe("runtime API route creation regression", () => {
  it("should register a new API route at runtime when a route.tsx file is created (no restart)", async () => {
    const projectRoot = join(tempRoot, "route-create-api");
    const appDir = join(projectRoot, "src", "app");
    const apiDir = join(appDir, "api", "status");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Create api/status directory before startup so the watcher can
    // detect files created in it
    mkdirSync(apiDir, { recursive: true });

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: /api/status should 404
      const beforeRes = await fetchUrl(`${baseUrl}/api/status`);
      expect(beforeRes.status).toBe(404);

      // Step 2: Create api/status/route.tsx at runtime
      writeFileSync(
        join(apiDir, "route.tsx"),
        `export function GET() { return { ok: true }; }`,
      );

      // Step 3: Wait for the file watcher
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 4: /api/status should now return 200 with JSON
      const afterRes = await fetchUrl(`${baseUrl}/api/status`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body).toContain('"ok"');
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#12: Runtime Nested Layout Creation ────────────────────

describe("runtime nested layout creation regression", () => {
  it("should apply a newly created nested layout to existing pages at runtime (no restart)", async () => {
    const projectRoot = join(tempRoot, "layout-create-nested");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");

    mkdirSync(blogDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div className="root">{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Blog page (no layout yet)
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export default function Page() { return <h1>Blog</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: /blog should only have root layout
      const beforeRes = await fetchUrl(`${baseUrl}/blog`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body).toContain("Blog");
      expect(beforeRes.body).toContain("root");
      expect(beforeRes.body).not.toContain("blog-layout");

      // Step 2: Create blog/layout.tsx
      writeFileSync(
        join(blogDir, "layout.tsx"),
        `export default function BlogLayout({ children }: { children: any }) { return <section className="blog-layout">{children}</section>; }`,
      );

      // Step 3: Wait for the file watcher
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 4: /blog should now have the blog layout wrapper
      const afterRes = await fetchUrl(`${baseUrl}/blog`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body).toContain("Blog");
      expect(afterRes.body).toContain("blog-layout");

      // Home page should NOT have blog layout
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("root");
      expect(homeRes.body).not.toContain("blog-layout");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#12: Runtime Nested Layout Deletion ────────────────────

describe("runtime nested layout deletion regression", () => {
  it("should remove layout wrapper when nested layout is deleted at runtime (no restart)", async () => {
    const projectRoot = join(tempRoot, "layout-delete-nested");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");

    mkdirSync(blogDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div className="root">{children}</div>; }`,
    );

    // Blog layout
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children }: { children: any }) { return <section className="blog-layout">{children}</section>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Blog page
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export default function Page() { return <h1>Blog</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: /blog should have both root and blog layout
      const beforeRes = await fetchUrl(`${baseUrl}/blog`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body).toContain("Blog");
      expect(beforeRes.body).toContain("blog-layout");

      // Step 2: Delete blog/layout.tsx
      unlinkSync(join(blogDir, "layout.tsx"));

      // Step 3: Wait for the file watcher
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 4: /blog should still work but without blog-layout wrapper
      const afterRes = await fetchUrl(`${baseUrl}/blog`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body).toContain("Blog");
      expect(afterRes.body).toContain("root");
      expect(afterRes.body).not.toContain("blog-layout");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#13: Data Loading — load() export ──────────────────────

describe("data loading (load export) regression", () => {
  it("should call load() and pass data as prop to page component", async () => {
    const projectRoot = join(tempRoot, "data-loading");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Page with load() export
    writeFileSync(
      join(appDir, "page.tsx"),
      `export async function load() {
  return { title: "Hello from load", count: 42 };
}

export default function Page({ data }: { data: { title: string; count: number } }) {
  return <div>DATA:{data.title}:{data.count}</div>;
}`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Hello from load");
      expect(res.body).toContain("42");
      expect(res.body).toContain("DATA:");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#13: Data Loading — page without load() ────────────────

describe("page without load export regression", () => {
  it("should render page without data prop when no load() is exported", async () => {
    const projectRoot = join(tempRoot, "no-load-export");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Page without load() export
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>No Load</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("No Load");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#13: Data Loading — load() with dynamic route params ───

describe("data loading with dynamic route params regression", () => {
  it("should pass route params to load() and render with fetched data", async () => {
    const projectRoot = join(tempRoot, "data-loading-params");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog", "[slug]");

    mkdirSync(blogDir, { recursive: true });
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

    // Dynamic blog page with load() that uses params
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export async function load({ params }: { params: { slug: string } }) {
  return { postTitle: "Post: " + params.slug, views: 100 };
}

export default function BlogPost({ params, data }: { params: { slug: string }; data: { postTitle: string; views: number } }) {
  return <article>TITLE:{data.postTitle}:VIEWS:{data.views}</article>;
}`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/blog/my-post`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Post: my-post");
      expect(res.body).toContain("100");
      expect(res.body).toContain("TITLE:");
      expect(res.body).toContain("VIEWS:");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#13: Data Loading — load() error returns 500 ───────────

describe("data loading error regression", () => {
  it("should return 500 when load() throws an error", async () => {
    const projectRoot = join(tempRoot, "data-loading-error");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Valid home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Broken page with load() that throws
    const brokenDir = join(appDir, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(brokenDir, "page.tsx"),
      `export async function load() {
  throw new Error("Database connection failed");
}

export default function Page({ data }: { data: any }) {
  return <div>{data}</div>;
}`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Home page should still work
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      // Broken page should return 500 (load() threw)
      const brokenRes = await fetchUrl(`${baseUrl}/broken`);
      expect(brokenRes.status).toBe(500);
      expect(brokenRes.body).toContain("Database connection failed");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#13: Data Loading — load() hot reload ──────────────────

describe("data loading hot reload regression", () => {
  it("should serve updated data after load() is modified (no restart)", async () => {
    const projectRoot = join(tempRoot, "data-loading-hmr");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Page with load() — initially returns version 1
    writeFileSync(
      join(appDir, "page.tsx"),
      `export async function load() {
  return { version: "v1" };
}

export default function Page({ data }: { data: { version: string } }) {
  return <span>Version:{data.version}</span>;
}`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Step 1: Request / and see v1
      const resA = await fetchUrl(`${baseUrl}/`);
      expect(resA.status).toBe(200);
      expect(resA.body).toContain("Version:");
      expect(resA.body).toContain("v1");

      // Step 2: Edit page.tsx to return v2
      writeFileSync(
        join(appDir, "page.tsx"),
        `export async function load() {
  return { version: "v2" };
}

export default function Page({ data }: { data: { version: string } }) {
  return <span>Version:{data.version}</span>;
}`,
      );

      // Step 3: Wait for the file watcher to detect the change
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Step 4: Request / again — should see v2
      const resB = await fetchUrl(`${baseUrl}/`);
      expect(resB.status).toBe(200);
      expect(resB.body).toContain("v2");
      expect(resB.body).not.toContain("v1");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Production Build Tests ──────────────────────────────────────────

/**
 * Helper: Start the production server as a subprocess.
 * The generated server.js uses Bun.serve() which starts a real HTTP server.
 * We run it as a subprocess, wait for it to be ready, then make requests.
 */
async function startProdServer(
  projectRoot: string,
  port: number,
): Promise<{ baseUrl: string; cleanup: () => void }> {
  const serverPath = join(projectRoot, "dist", "server.js");
  
  const proc = Bun.spawn(["bun", "run", serverPath], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the server to be ready
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    baseUrl: `http://localhost:${port}`,
    cleanup: () => {
      proc.kill();
    },
  };
}

// Use a base port that's unlikely to conflict with dev server tests
let prodTestPort = 3600;

describe("production build with dynamic routes", () => {
  it("should build successfully with dynamic routes (no crash)", async () => {
    const projectRoot = join(tempRoot, "prod-dynamic-build");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "blog", "[slug]"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(appDir, "blog", "[slug]", "page.tsx"),
      `export default function Page({ params }: { params: { slug: string } }) { return <div>Blog: {params.slug}</div>; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);

      // This should NOT throw — dynamic routes should not crash the build
      const result = await buildApp({ root: projectRoot });

      expect(result.routes).toBe(2); // / and /blog/[slug]
      expect(existsSync(join(result.outDir, "server.js"))).toBe(true);
      expect(existsSync(join(result.outDir, "_meiden", "server"))).toBe(true);

      // Pre-rendered HTML for static route
      expect(existsSync(join(result.outDir, "index.html"))).toBe(true);

      // No pre-rendered HTML for dynamic route (it's served by runtime SSR)
      expect(existsSync(join(result.outDir, "blog", "[slug]", "index.html"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should serve dynamic route params correctly in production", async () => {
    const projectRoot = join(tempRoot, "prod-dynamic-serve");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "blog", "[slug]"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(appDir, "blog", "[slug]", "page.tsx"),
      `export default function Page({ params }: { params: { slug: string } }) { return <div>Blog: {params.slug}</div>; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // Test dynamic route with params
        const res = await fetchUrl(`${baseUrl}/blog/hello`);
        expect(res.status).toBe(200);
        expect(res.body).toContain("hello");

        // Test dynamic route with different params
        const res2 = await fetchUrl(`${baseUrl}/blog/world`);
        expect(res2.status).toBe(200);
        expect(res2.body).toContain("world");

        // Test static route still works
        const res3 = await fetchUrl(`${baseUrl}/`);
        expect(res3.status).toBe(200);
        expect(res3.body).toContain("Home");
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should return 404 for malformed percent-encoded params in production", async () => {
    const projectRoot = join(tempRoot, "prod-malformed-params");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "blog", "[slug]"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "blog", "[slug]", "page.tsx"),
      `export default function Page({ params }: { params: { slug: string } }) { return <div>Blog: {params.slug}</div>; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // Malformed percent-encoding should return 404 (no match), not crash
        const res = await fetchUrl(`${baseUrl}/blog/%E0%A4%A`);
        expect(res.status).toBe(404);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("production build with API routes", () => {
  it("should build and serve API routes in production", async () => {
    const projectRoot = join(tempRoot, "prod-api-routes");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "api", "hello"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(appDir, "api", "hello", "route.ts"),
      `export function GET() {
  return new Response(JSON.stringify({ hello: "world" }), {
    headers: { "content-type": "application/json" },
  });
}

export function POST() {
  return new Response(JSON.stringify({ method: "POST" }), {
    headers: { "content-type": "application/json" },
  });
}`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // GET /api/hello
        const res = await fetchUrl(`${baseUrl}/api/hello`);
        expect(res.status).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.hello).toBe("world");

        // POST /api/hello
        const res2 = await fetchUrl(`${baseUrl}/api/hello`, { method: "POST" });
        expect(res2.status).toBe(200);
        const data2 = JSON.parse(res2.body);
        expect(data2.method).toBe("POST");

        // DELETE /api/hello — unsupported method → 405
        const res3 = await fetchUrl(`${baseUrl}/api/hello`, { method: "DELETE" });
        expect(res3.status).toBe(405);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should serve dynamic API route params in production", async () => {
    const projectRoot = join(tempRoot, "prod-api-dynamic");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "api", "user", "[id]"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(appDir, "api", "user", "[id]", "route.ts"),
      `export function GET({ params }: { params: { id: string } }) {
  return new Response(JSON.stringify({ id: params.id }), {
    headers: { "content-type": "application/json" },
  });
}`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        const res = await fetchUrl(`${baseUrl}/api/user/42`);
        expect(res.status).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.id).toBe("42");
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should return controlled 500 for broken API route in production", async () => {
    const projectRoot = join(tempRoot, "prod-api-broken");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "api", "broken"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(appDir, "api", "broken", "route.ts"),
      `export function GET() {
  throw new Error("Something went wrong");
}`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // Broken API route should return controlled 500, not crash the server
        const res = await fetchUrl(`${baseUrl}/api/broken`);
        expect(res.status).toBe(500);

        // Server should still be alive for other routes
        const res2 = await fetchUrl(`${baseUrl}/`);
        expect(res2.status).toBe(200);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should serve API route instead of page when both exist at same path in production", async () => {
    const projectRoot = join(tempRoot, "prod-api-priority");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "api", "data"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    // Page at /api/data — would normally be pre-rendered to HTML
    writeFileSync(
      join(appDir, "api", "data", "page.tsx"),
      `export default function DataPage() { return <div>Data Page Content</div>; }`,
    );
    // API route at /api/data — should take priority over the page
    writeFileSync(
      join(appDir, "api", "data", "route.ts"),
      `export function GET() {
  return new Response(JSON.stringify({ source: "api" }), {
    headers: { "content-type": "application/json" },
  });
}`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // /api/data should return the API route JSON, NOT the page HTML
        const res = await fetchUrl(`${baseUrl}/api/data`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const data = JSON.parse(res.body);
        expect(data.source).toBe("api");

        // Home page should still work
        const homeRes = await fetchUrl(`${baseUrl}/`);
        expect(homeRes.status).toBe(200);
        expect(homeRes.body).toContain("Home");
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#16: Nested Layout Receives Params (Dev) ────────────────

describe("nested layout receives params regression", () => {
  it("should pass params to nested layout in dev server", async () => {
    const projectRoot = join(tempRoot, "layout-params-dev");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog", "[slug]");

    mkdirSync(blogDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    // Root layout
    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );

    // Home page
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );

    // Blog nested layout that uses params
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export default function BlogLayout({ children, params }: { children: any; params: { slug: string } }) { return <section>LAYOUT:{params.slug}:{children}</section>; }`,
    );

    // Blog post page
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em>{params.slug}</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/blog/my-post`);
      expect(res.status).toBe(200);
      // Nested layout should have received params
      expect(res.body).toContain("LAYOUT:");
      expect(res.body).toContain("my-post");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#16: Production Server — API Auto-JSON Wrapping ──────────

describe("production API route auto-JSON wrapping", () => {
  it("should auto-JSON-encode non-Response return values from API handlers", async () => {
    const projectRoot = join(tempRoot, "prod-api-json-wrap");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "api", "data"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    // API route returning plain object (not Response) — should be auto-JSON-wrapped
    writeFileSync(
      join(appDir, "api", "data", "route.ts"),
      `export function GET() { return { message: "hello", count: 42 }; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        const res = await fetchUrl(`${baseUrl}/api/data`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const data = JSON.parse(res.body);
        expect(data.message).toBe("hello");
        expect(data.count).toBe(42);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#16: Production Server — Nested Layout Receives Params ──

describe("production nested layout receives params", () => {
  it("should pass params to nested layout in production server", async () => {
    const projectRoot = join(tempRoot, "prod-layout-params");
    const appDir = join(projectRoot, "app");

    mkdirSync(join(appDir, "blog", "[slug]"), { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    // Blog nested layout that uses params
    writeFileSync(
      join(appDir, "blog", "layout.tsx"),
      `export default function BlogLayout({ children, params }: { children: any; params: { slug: string } }) { return <section>LAYOUT:{params.slug}:{children}</section>; }`,
    );
    // Blog post page
    writeFileSync(
      join(appDir, "blog", "[slug]", "page.tsx"),
      `export default function Page({ params }: { params: { slug: string } }) { return <em>Post:{params.slug}</em>; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        const res = await fetchUrl(`${baseUrl}/blog/test-post`);
        expect(res.status).toBe(200);
        // Nested layout should have received params
        expect(res.body).toContain("LAYOUT:");
        expect(res.body).toContain("test-post");
        // Page should also work
        expect(res.body).toContain("Post:");
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test PR#16: Static Server — Malformed URL Returns 404 ──────────

describe("production static server malformed URL regression", () => {
  it("should return 404 for malformed percent-encoded URLs in static site (no crash)", async () => {
    const projectRoot = join(tempRoot, "prod-static-malformed");
    const appDir = join(projectRoot, "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function Layout({ children }: { children: any }) { return <html><body>{children}</body></html>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <div>Home</div>; }`,
    );
    writeFileSync(
      join(projectRoot, "meiden.config.ts"),
      `export default { appDir: "app" };`,
    );

    try {
      const devModulePath = join(import.meta.dir, "..", "src", "dev", "index.tsx");
      const { buildApp } = await import(devModulePath);
      await buildApp({ root: projectRoot });

      // This is a static-only site, so it uses buildStaticServer
      const port = prodTestPort++;
      const { baseUrl, cleanup } = await startProdServer(projectRoot, port);

      try {
        // Valid request should work
        const validRes = await fetchUrl(`${baseUrl}/`);
        expect(validRes.status).toBe(200);
        expect(validRes.body).toContain("Home");

        // Malformed URL should return 404, not crash
        const malformedRes = await fetchUrl(`${baseUrl}/%E0%A4%A`);
        expect(malformedRes.status).toBe(404);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── PR #17: createLayoutWrapper Integration Tests ──────────────────
//
// These tests replace the old stale `createLayoutWrapper` unit test that
// broke when the nested layout API changed. Instead of testing the
// internal function shape, we test the public/observable rendering
// behavior through the full dev server pipeline.
//
// Coverage:
//   - Root layout only (no nested)
//   - Nested layout chain ordering (Root > Blog > Slug > Page)
//   - Params passing to all layout levels
//   - Data passing through layouts (load() → data prop)
//   - Page rendering through the full render pipeline
//   - Layout without default export returns 500
//   - Deeply nested layouts (3+ levels)

describe("layout rendering pipeline — root layout only", () => {
  it("should render page content wrapped by root layout with no nested layouts", async () => {
    const projectRoot = join(tempRoot, "pipeline-root-only");
    const appDir = join(projectRoot, "src", "app");
    const aboutDir = join(appDir, "about");

    mkdirSync(aboutDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div data-root="true">{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );
    writeFileSync(
      join(aboutDir, "page.tsx"),
      `export default function Page() { return <h1>About</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("data-root");
      expect(homeRes.body).toContain("Home");

      const aboutRes = await fetchUrl(`${baseUrl}/about`);
      expect(aboutRes.status).toBe(200);
      expect(aboutRes.body).toContain("data-root");
      expect(aboutRes.body).toContain("About");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — nested layout chain ordering", () => {
  it("should render layouts in correct nesting order: Root > Section > SubSection > Page", async () => {
    const projectRoot = join(tempRoot, "pipeline-chain-order");
    const appDir = join(projectRoot, "src", "app");
    const sectionDir = join(appDir, "docs");
    const subSectionDir = join(sectionDir, "advanced");

    mkdirSync(subSectionDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div data-l="root">{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <span data-l="home-page">Home</span>; }`,
    );
    writeFileSync(
      join(sectionDir, "layout.tsx"),
      `export default function DocsLayout({ children }: { children: any }) { return <section data-l="docs">{children}</section>; }`,
    );
    writeFileSync(
      join(subSectionDir, "layout.tsx"),
      `export default function AdvancedLayout({ children }: { children: any }) { return <article data-l="advanced">{children}</article>; }`,
    );
    writeFileSync(
      join(subSectionDir, "page.tsx"),
      `export default function Page() { return <em data-l="page">Content</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Home page should only have root layout
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain('data-l="root"');
      expect(homeRes.body).toContain('data-l="home-page"');
      expect(homeRes.body).not.toContain('data-l="docs"');
      expect(homeRes.body).not.toContain('data-l="advanced"');

      // /docs/advanced should have all three layout levels
      const advRes = await fetchUrl(`${baseUrl}/docs/advanced`);
      expect(advRes.status).toBe(200);
      expect(advRes.body).toContain('data-l="root"');
      expect(advRes.body).toContain('data-l="docs"');
      expect(advRes.body).toContain('data-l="advanced"');
      expect(advRes.body).toContain('data-l="page"');

      // Verify nesting order: root appears before docs, docs before advanced, advanced before page
      const rootIdx = advRes.body.indexOf('data-l="root"');
      const docsIdx = advRes.body.indexOf('data-l="docs"');
      const advIdx = advRes.body.indexOf('data-l="advanced"');
      const pageIdx = advRes.body.indexOf('data-l="page"');
      expect(rootIdx).toBeLessThan(docsIdx);
      expect(docsIdx).toBeLessThan(advIdx);
      expect(advIdx).toBeLessThan(pageIdx);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — params pass to all layout levels", () => {
  it("should pass dynamic route params to root layout, nested layouts, and page", async () => {
    const projectRoot = join(tempRoot, "pipeline-params-all");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog", "[slug]");

    mkdirSync(blogDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children, params }: { children: any; params: any }) { return <div data-root-params={JSON.stringify(params)}>{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );
    writeFileSync(
      join(join(appDir, "blog"), "layout.tsx"),
      `export default function BlogLayout({ children, params }: { children: any; params: { slug: string } }) { return <section data-blog-slug={params.slug}>{children}</section>; }`,
    );
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export default function BlogPost({ params }: { params: { slug: string } }) { return <em data-page-slug={params.slug}>Post</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/blog/test-post`);
      expect(res.status).toBe(200);
      // Nested layout should have the slug param
      expect(res.body).toContain("data-blog-slug");
      expect(res.body).toContain("test-post");
      // Page should also have the slug param
      expect(res.body).toContain("data-page-slug");
      expect(res.body).toContain("test-post");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — data passes through layouts", () => {
  it("should render page with load() data prop through layout chain", async () => {
    const projectRoot = join(tempRoot, "pipeline-data-through-layouts");
    const appDir = join(projectRoot, "src", "app");

    mkdirSync(appDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div data-root>{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export async function load() { return { title: "Loaded Title", items: [1, 2, 3] }; }
export default function Page({ data }: { data: { title: string; items: number[] } }) { return <span data-loaded={data.title}>{data.title}:{data.items.length}</span>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/`);
      expect(res.status).toBe(200);
      // Layout wrapper present
      expect(res.body).toContain("data-root");
      // Page received data from load()
      expect(res.body).toContain("data-loaded");
      expect(res.body).toContain("Loaded Title");
      expect(res.body).toContain("3");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — broken layout returns 500", () => {
  it("should return 500 when a nested layout has no default export, without crashing other routes", async () => {
    const projectRoot = join(tempRoot, "pipeline-broken-layout");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog");
    const contactDir = join(appDir, "contact");

    mkdirSync(blogDir, { recursive: true });
    mkdirSync(contactDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div>{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );
    // Blog layout with NO default export (broken)
    writeFileSync(
      join(blogDir, "layout.tsx"),
      `export const broken = true;`,
    );
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export default function Page() { return <h1>Blog</h1>; }`,
    );
    // Contact page — no nested layout, should work fine
    writeFileSync(
      join(contactDir, "page.tsx"),
      `export default function Page() { return <h1>Contact</h1>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      // Home and contact should work fine (no broken layout)
      const homeRes = await fetchUrl(`${baseUrl}/`);
      expect(homeRes.status).toBe(200);
      expect(homeRes.body).toContain("Home");

      const contactRes = await fetchUrl(`${baseUrl}/contact`);
      expect(contactRes.status).toBe(200);
      expect(contactRes.body).toContain("Contact");

      // Blog should 500 because the nested layout is broken
      const blogRes = await fetchUrl(`${baseUrl}/blog`);
      expect(blogRes.status).toBe(500);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — deeply nested 4-level layout chain", () => {
  it("should render correctly with 4 levels of nested layouts", async () => {
    const projectRoot = join(tempRoot, "pipeline-deep-nesting");
    const appDir = join(projectRoot, "src", "app");
    const level1Dir = join(appDir, "a");
    const level2Dir = join(level1Dir, "b");
    const level3Dir = join(level2Dir, "c");

    mkdirSync(level3Dir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function L0({ children }: { children: any }) { return <div data-level="0">{children}</div>; }`,
    );
    writeFileSync(
      join(level1Dir, "layout.tsx"),
      `export default function L1({ children }: { children: any }) { return <section data-level="1">{children}</section>; }`,
    );
    writeFileSync(
      join(level2Dir, "layout.tsx"),
      `export default function L2({ children }: { children: any }) { return <article data-level="2">{children}</article>; }`,
    );
    writeFileSync(
      join(level3Dir, "layout.tsx"),
      `export default function L3({ children }: { children: any }) { return <span data-level="3">{children}</span>; }`,
    );
    writeFileSync(
      join(level3Dir, "page.tsx"),
      `export default function Page() { return <em data-level="page">Deep</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/a/b/c`);
      expect(res.status).toBe(200);
      // All 4 layout levels + page should be present
      expect(res.body).toContain('data-level="0"');
      expect(res.body).toContain('data-level="1"');
      expect(res.body).toContain('data-level="2"');
      expect(res.body).toContain('data-level="3"');
      expect(res.body).toContain('data-level="page"');

      // Verify ordering: level 0 appears before 1, 1 before 2, etc.
      const idx0 = res.body.indexOf('data-level="0"');
      const idx1 = res.body.indexOf('data-level="1"');
      const idx2 = res.body.indexOf('data-level="2"');
      const idx3 = res.body.indexOf('data-level="3"');
      const idxP = res.body.indexOf('data-level="page"');
      expect(idx0).toBeLessThan(idx1);
      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
      expect(idx3).toBeLessThan(idxP);
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("layout rendering pipeline — data loading with nested layout and dynamic params", () => {
  it("should render page with load() data and params through nested layout chain", async () => {
    const projectRoot = join(tempRoot, "pipeline-data-params-nested");
    const appDir = join(projectRoot, "src", "app");
    const blogDir = join(appDir, "blog", "[slug]");

    mkdirSync(blogDir, { recursive: true });
    symlinkNodeModules(projectRoot);
    writePackageJson(projectRoot);

    writeFileSync(
      join(appDir, "layout.tsx"),
      `export default function RootLayout({ children }: { children: any }) { return <div data-root>{children}</div>; }`,
    );
    writeFileSync(
      join(appDir, "page.tsx"),
      `export default function Page() { return <h1>Home</h1>; }`,
    );
    writeFileSync(
      join(join(appDir, "blog"), "layout.tsx"),
      `export default function BlogLayout({ children, params }: { children: any; params: { slug: string } }) { return <section data-blog-slug={params.slug}>{children}</section>; }`,
    );
    writeFileSync(
      join(blogDir, "page.tsx"),
      `export async function load({ params }: { params: { slug: string } }) { return { title: "Post: " + params.slug }; }
export default function BlogPost({ params, data }: { params: { slug: string }; data: { title: string } }) { return <em data-slug={params.slug} data-title={data.title}>{data.title}</em>; }`,
    );

    const { baseUrl, app } = await startDevServer(projectRoot);

    try {
      const res = await fetchUrl(`${baseUrl}/blog/hello-world`);
      expect(res.status).toBe(200);
      // Root layout
      expect(res.body).toContain("data-root");
      // Blog nested layout received params
      expect(res.body).toContain("data-blog-slug");
      expect(res.body).toContain("hello-world");
      // Page received both params and data
      expect(res.body).toContain("data-slug");
      expect(res.body).toContain("data-title");
      expect(res.body).toContain("Post: hello-world");
    } finally {
      app.stop?.();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
