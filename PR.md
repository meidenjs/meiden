# Fix: Island SSR Rendering, Bundle Optimization, and Build Reliability

## Summary

This PR addresses multiple issues in the Meiden framework's build system, island architecture, and production server:

1. **Island flash of empty content** — Islands were rendered as empty `<div>` placeholders on the server, causing a visible flash before JavaScript loads and hydrates them. ✅ Fixed (island proxy now renders real component HTML).

2. **React duplicate bundles** — Each island bundle included its own copy of React + ReactDOM (~328 KB each). Now deduplicated with code splitting. ✅ Fixed.

3. **Oversized production server** — server.js bundled Elysia + React + ReactDOM (~621 KB). Replaced with a lightweight static file server (~2 KB). ✅ Fixed.

4. **Unreliable island-to-bundle mapping** — The build used first-come-first-served matching to map islands to their bundles, which could assign the wrong bundle to the wrong island. ✅ Fixed with deterministic entry point naming.

5. **Silent SSR error swallowing** — Island proxy caught rendering errors silently, hiding bugs. ✅ Fixed with proper error logging.

6. **Dangerous HTML unescaping** — `createProductionApp` used `unescapeHTML` on SSR output, which could reintroduce XSS-escaped content. ✅ Fixed by removing the unescape call.

## Changes

### 1. Island SSR with real component rendering

**Before:**
```html
<div data-meiden-island="app/components/Counter.tsx" data-meiden-props="..."></div>
<!-- Empty! User sees nothing until JS loads -->
```

**After:**
```html
<div data-meiden-island="app/components/Counter.tsx" data-meiden-props="...">
  <button class="counter" type="button">Count 3</button>
</div>
<!-- Real content! User sees the button immediately -->
```

The island proxy imports and renders the actual component on the server. If SSR crashes (e.g. browser-only code at the top level), it falls back to an empty placeholder and logs the error.

### 2. React bundle deduplication with code splitting

**Before:**
| File | Size |
|------|------|
| Counter.js | 328 KB (Counter + React + ReactDOM) |
| ThemeToggle.js | 328 KB (ThemeToggle + React + ReactDOM) |
| HookGallery.js | 328 KB (HookGallery + React + ReactDOM) |
| **Total** | **~984 KB** |

**After:**
| File | Size |
|------|------|
| chunk-*.js (shared) | 324 KB (React + ReactDOM — loaded once) |
| HookGallery.js | 2.70 KB |
| ThemeToggle.js | 0.54 KB |
| Counter.js | 0.37 KB |
| **Total** | **~328 KB** |

All islands are built in a single `Bun.build` call with `splitting: true`, which extracts shared dependencies into a separate chunk.

### 3. Lightweight static production server

**Before:** server.js = ~621 KB (Elysia + React + ReactDOM bundled)

**After:** server.js = ~2 KB (simple `Bun.serve` for static files)

Since `meiden build` pre-renders all pages as static HTML, a full SSR server with Elysia is unnecessary for serving the build output. The new server is a minimal static file server.

### 4. Reliable island-to-bundle mapping

**Before:** First-come-first-served matching — iterated over all build outputs and assigned the first non-shared chunk to each island regardless of which island it actually belonged to. This could cause islands to receive the wrong JavaScript bundle.

**After:** Deterministic entry point naming based on island identity (`island-${hash(source:exportName)}`). A mapping table (`entryToIslandKey`) tracks which entry point filename corresponds to which island key. After building, each output is matched directly to its island by filename, eliminating any ambiguity.

### 5. SSR error logging

**Before:** `catch {}` — errors during island SSR were silently swallowed.

**After:** `catch (error) { console.error("[meiden] SSR failed for island ...", error); }` — errors are logged with the island identifier, making debugging much easier while still providing the empty-placeholder fallback.

### 6. Removed dangerous `unescapeHTML`

**Before:** `createProductionApp` called `unescapeHTML()` on the full SSR output, which could turn `&lt;script&gt;` back into `<script>`, reintroducing XSS vulnerabilities.

**After:** The function is removed entirely. React's `renderToString` already produces properly escaped HTML; there is no need to unescape it.

## How to test

```bash
# Dev server - islands should show content immediately (no flash)
bun run dev

# Build - should produce small island bundles with shared React chunk
bun run build

# Production server - all routes should serve correctly
bun run start
```

## Files changed

- `src/dev/index.tsx` — Island proxy SSR, build splitting, reliable mapping, error logging, static server
- `src/runtime/server.tsx` — Removed `unescapeHTML`, cleaned up `createProductionApp`
- `.gitignore` — Added `.meiden` build artifacts
