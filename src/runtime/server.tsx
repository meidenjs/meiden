import * as React from "react";
import * as ReactDOMServer from "react-dom/server";
import { Elysia } from "elysia";
import { type Component } from "../dev/index.tsx";
import { injectIslandRuntime, getContentType } from "./utils";

export interface AppRoute {
  path: string;
  Page: Component;
}

export interface ProductionServerOptions {
  routes: AppRoute[];
  RootLayout: Component;
  distRoot: string;
  render: (element: React.ReactElement) => string;
  port?: number;
}

function unescapeHTML(str: string) {
  return str.replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&amp;/g, "&");
}

export function createProductionApp({ routes, RootLayout, distRoot, render }: ProductionServerOptions) {
  const app = new Elysia().onRequest(({ request }) => {
    console.log(`\x1b[2m${request.method}\x1b[0m ${new URL(request.url).pathname}`);
  });

  // Serve static assets
  app.get("/_meiden/*", async ({ request, set }) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = `${distRoot}/${pathname}`;
    
    const file = Bun.file(filePath);
    if (await file.exists()) {
      set.headers["content-type"] = getContentType(filePath);
      return file;
    }
    return new Response("Not found", { status: 404 });
  });

  // SSR Routes
  for (const route of routes) {
    app.get(route.path, async ({ set }) => {
      const startedAt = performance.now();
      try {
        const element = React.createElement(RootLayout, { 
          children: React.createElement(route.Page) 
        });
        let markup = render(element);
        
        // Ensure it's unescaped
        markup = unescapeHTML(markup);
        
        const content = injectIslandRuntime(`<!DOCTYPE html>${markup}`, "/_meiden/islands/runtime.js");
        
        console.log(`\x1b[32m200\x1b[0m  GET   ${route.path}     ${(performance.now() - startedAt).toFixed(2)}ms`);
        
        set.headers["content-type"] = "text/html; charset=utf-8";
        return new Response(content, {
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        });
      } catch (error: any) {
        console.log(`\x1b[31m500\x1b[0m  GET   ${route.path}     ${(performance.now() - startedAt).toFixed(2)}ms`);
        console.error(error);
        return new Response(error.message || "Internal Server Error", { status: 500 });
      }
    });
  }

  return app;
}
