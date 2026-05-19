import { extname } from "node:path";

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

export function getContentType(filePath: string): string {
  const ext = extname(filePath);
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".json": "application/json",
  };
  return types[ext] || "text/plain";
}
