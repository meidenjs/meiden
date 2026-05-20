import { extname } from "node:path";

// ─── MIME Types (Single Source of Truth) ────────────────────────────
// All content-type lookups across dev server, production server,
// and generated static server must use this map.

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

export function getContentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
}

/**
 * Return the CONTENT_TYPES map as a serializable object for embedding
 * in the generated static server.js. Filters to only the types that
 * a static file server typically needs.
 */
export function getContentTypeMapForServer(): Record<string, string> {
  return { ...CONTENT_TYPES };
}

// ─── Island Runtime Injection ───────────────────────────────────────

export function injectIslandRuntime(html: string, runtimePath: string) {
  if (!html.includes("data-meiden-island")) {
    return html;
  }

  const script = `<script type="module" src="${runtimePath}"></script>`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}</body>`);
  }

  return `${html}${script}`;
}

// ─── Shared CLI Colors ──────────────────────────────────────────────
// Used by both cli.ts and dev/index.tsx to avoid duplication.

export const colors = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

export function color(value: string | number, ansi: string) {
  return `${ansi}${value}${colors.reset}`;
}

export function statusColor(status: number) {
  if (status >= 500) {
    return colors.red;
  }

  if (status >= 400) {
    return colors.yellow;
  }

  return colors.green;
}

export function formatDuration(start: number) {
  const duration = performance.now() - start;

  if (duration < 1) {
    return `${Math.round(duration * 1000)}us`;
  }

  return duration < 10 ? `${duration.toFixed(2)}ms` : `${duration.toFixed(1)}ms`;
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
