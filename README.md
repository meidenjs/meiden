# Meiden

Meiden is an experimental full-stack web framework for Bun. It uses an app-router file convention, server-renders routes, and automatically turns interactive React components into hydrated islands.

## Status

This is an early prototype. The current implementation supports:

- `meiden dev` for a local dev server
- `meiden build` for static HTML output
- `meiden start` for serving the built app in production mode
- `page.tsx` app routes
- configurable app directory
- automatic island detection from TSX AST analysis
- React island hydration for detected client components

## CLI

```bash
meiden dev [dir] [--port 3000]
meiden build [dir]
meiden start [dir] [--port 3000]
```

In this repository, run the example app with:

```bash
bun run dev
```

Build the example app:

```bash
bun run build
```

Start the built example app:

```bash
bun run start
```

The build output is written to the app's `dist` directory. The production server serves that directory, including generated island bundles under `_meiden/islands`.

## App Router

Meiden routes are files named `page.tsx` under the configured app directory.

```txt
app/page.tsx          -> /
app/docs/page.tsx     -> /docs
app/blog/page.tsx     -> /blog
```

Each app needs a root layout:

```txt
app/layout.tsx
```

Example:

```tsx
export default function Layout({ children }: { children: any }) {
  return (
    <html lang="en">
      <head>
        <title>Meiden App</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## Config

Create `meiden.config.ts` in the app root.

```ts
export default {
  appDir: "app",
};
```

If no config exists, Meiden defaults to:

```ts
export default {
  appDir: "src/app",
};
```

## Automatic Islands

Write normal React components. Meiden parses TSX with `oxc-parser` and detects client behavior.

```tsx
import { useState } from "react";

export default function Counter({ initial = 0 }) {
  const [count, setCount] = useState(initial);

  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Count {count}
    </button>
  );
}
```

Use it normally from a server-rendered page:

```tsx
import Counter from "./components/Counter";

export default function Page() {
  return <Counter initial={3} />;
}
```

Meiden detects the component as an island, server-renders a placeholder, and hydrates only that component in the browser.

Detected signals include:

- `"use client"`
- React hooks such as `useState`, `useEffect`, `useMemo`, `useContext`, `useReducer`, `useRef`, `useTransition`
- JSX event props such as `onClick`, `onInput`, `onSubmit`
- browser globals such as `window`, `document`, `localStorage`, `navigator`

## Build Output

`meiden build` creates a clean `dist` directory:

```txt
dist/
  index.html
  docs/index.html
  _meiden/islands/runtime.js
  _meiden/islands/<hash>.js
```

Files from `public/` are copied into `dist/`.

Run the production server after building:

```bash
bun run src/cli.ts start example
```

Production routes are resolved from built HTML files:

```txt
dist/index.html       -> /
dist/docs/index.html  -> /docs
```

## Development Logs

The dev server prints a small ready banner:

```txt
Meiden ready

  Local:   http://localhost:3000
  Network: http://192.168.1.10:3000
```

Requests are logged with status, method, route, and duration:

```txt
200  GET   /docs     250us
200  GET   /         1.42ms
```
