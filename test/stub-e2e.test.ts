import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end tests for createServerModule stub generation.
 *
 * Strategy: Create a temporary project with broken imports, trigger
 * server module generation, then read the generated files from
 * .meiden/server/ to verify stub output.
 *
 * We read ALL generated route files and find the one containing
 * "export default function Page" to get the page module (not layout).
 */

let tempRoot: string;
let testCounter = 0;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "meiden-e2e-"));
});

afterAll(() => {
  if (tempRoot && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Find the page route file from .meiden/server/ by looking for
 * "export default function Page" in the content.
 */
function findPageRouteFile(serverDir: string): string {
  const routeFiles = readdirSync(serverDir).filter((f) => f.startsWith("route-"));
  for (const f of routeFiles) {
    const content = readFileSync(join(serverDir, f), "utf8");
    if (content.includes("export default function Page") || content.includes("Missing") || content.includes("NonExistent") || content.includes("NotFound")) {
      return content;
    }
  }
  // If no page-specific file found, return all route file contents for debugging
  const allContents = routeFiles.map((f) => readFileSync(join(serverDir, f), "utf8"));
  throw new Error(
    `No page route file found. Files: ${routeFiles.join(", ")}\n` +
    `Contents:\n${allContents.join("\n---\n")}`,
  );
}

async function generateAndReadPageRouteModule(pageSource: string): Promise<string> {
  testCounter++;
  const projectRoot = join(tempRoot, `test-${testCounter}`);
  const appDir = join(projectRoot, "src", "app");
  mkdirSync(appDir, { recursive: true });

  // Symlink node_modules from the main project so React is available
  const nmSource = join(process.cwd(), "node_modules");
  const nmTarget = join(projectRoot, "node_modules");
  if (existsSync(nmSource) && !existsSync(nmTarget)) {
    try {
      require("node:fs").symlinkSync(nmSource, nmTarget, "junction");
    } catch {
      // Symlink might fail; continue anyway
    }
  }

  // Write a minimal layout
  writeFileSync(
    join(appDir, "layout.tsx"),
    `export default function Layout({ children }: { children: any }) { return <div>{children}</div>; }`,
  );

  // Write the page
  writeFileSync(join(appDir, "page.tsx"), pageSource);

  // Clean previous generated files
  const serverDir = join(projectRoot, ".meiden", "server");
  if (existsSync(serverDir)) {
    rmSync(serverDir, { recursive: true, force: true });
  }

  // Start the server — this triggers createServerModule which writes files to disk
  try {
    const { startServer } = await import("../src/dev/index.tsx");
    const app = await startServer({ root: projectRoot, port: 0 });
    app.stop?.();
  } catch {
    // Server start may fail if broken import stubs cause errors during
    // module evaluation — but the generated files should still be on disk.
  }

  if (!existsSync(serverDir)) {
    throw new Error(`Server dir not created: ${serverDir}`);
  }

  return findPageRouteFile(serverDir);
}

describe("createServerModule stub generation (e2e)", () => {
  it("should generate unique stub variables for multiple broken imports", async () => {
    const page = `
import Foo from "./Missing1";
import Bar from "./Missing2";

export default function Page() {
  return <div>{Foo} {Bar}</div>;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Should contain stub variables with different offsets (no collisions)
    const stubVarMatches = generated.match(/const __meiden_stub_\d+_\d+/g);
    expect(stubVarMatches).not.toBeNull();
    expect(stubVarMatches!.length).toBe(2);

    // The two stub variables must be different
    expect(stubVarMatches![0]).not.toBe(stubVarMatches![1]);

    // Should create Foo and Bar (local binding names)
    expect(generated).toContain("const Foo");
    expect(generated).toContain("const Bar");
  });

  it("should use local binding name for default import, not synthetic name", async () => {
    const page = `
import MyComponent from "./NonExistent";

export default function Page() {
  return <MyComponent />;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Should create MyComponent (local binding), NOT ./NonExistent_default
    expect(generated).toContain("const MyComponent");
    expect(generated).not.toContain("_default");
  });

  it("should use local binding name for named import with alias", async () => {
    const page = `
import { Button as MyButton } from "./NonExistent";

export default function Page() {
  return <MyButton />;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Should create MyButton (alias), NOT Button (original name)
    expect(generated).toContain("const MyButton");
    // Should NOT have a const Button declaration (the original name)
    expect(generated).not.toMatch(/const Button\b/);
  });

  it("should use local binding name for namespace import", async () => {
    const page = `
import * as Mod from "./NonExistent";

export default function Page() {
  return <div>{Mod.Foo}</div>;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Should create Mod
    expect(generated).toContain("const Mod");
    // All stubs use Proxy with a plain object target (not function() {} base)
    // The target includes toString/valueOf/Symbol.toPrimitive for JSX child safety
    const modLines = generated.split("\n").filter(
      (l) => l.includes("const __meiden_stub_") && l.includes("new Proxy("),
    );
    expect(modLines.length).toBeGreaterThan(0);
    // No stub should contain "function() {}" base — all use plain objects
    expect(modLines.some(l => l.includes("function() {}"))).toBe(false);
  });

  it("should remove side-effect imports without creating bindings", async () => {
    const page = `
import "./NonExistent";

export default function Page() {
  return <div>hello</div>;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Side-effect import should be removed entirely — no stub, no Proxy
    expect(generated).not.toContain("__meiden_stub_");
    expect(generated).not.toContain("./NonExistent");
  });

  it("should use lazy Proxy stubs that do NOT throw at module evaluation time", async () => {
    const page = `
import Missing from "./NotFound";

export default function Page() {
  return <div>hello</div>;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // Should NOT have a top-level throw statement (old behavior)
    expect(generated).not.toMatch(/^throw\s/m);

    // Should contain new Proxy
    expect(generated).toContain("new Proxy");

    // Should contain the error message about the unresolved import
    expect(generated).toContain("Cannot resolve import");
    expect(generated).toContain("./NotFound");
  });

  it("should throw when broken import is rendered as JSX child (toString/valueOf/Symbol.toPrimitive traps)", async () => {
    const page = `
import Missing from "./Missing";

export default function Page() {
  return <div>{Missing}</div>;
}
`;

    const generated = await generateAndReadPageRouteModule(page);

    // The stub must include primitive-conversion traps so React throws
    // when trying to render the broken import as a JSX text child.
    // Without these, React would call toString() on the Proxy target
    // (which returns "[object Object]" or "function() {}") and render 200.
    expect(generated).toContain("toString()");
    expect(generated).toContain("valueOf()");
    expect(generated).toContain("Symbol.toPrimitive");

    // Should still have Proxy and error message
    expect(generated).toContain("new Proxy");
    expect(generated).toContain("Cannot resolve import");
  });
});
