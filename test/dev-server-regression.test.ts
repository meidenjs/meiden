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
  const nmSource = join(process.cwd(), "node_modules");
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
  const { startServer } = await import("../src/dev/index.tsx");
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
      const { startServer } = await import("../src/dev/index.tsx");
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
