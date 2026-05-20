export default function DocsPage() {
  return (
    <>
      <section className="page-head">
        <p className="eyebrow">Routing convention</p>
        <h1>Every page file becomes a route.</h1>
        <p className="lead">
          Meiden scans `src/app` for `page.tsx` files, then wraps each route in
          `src/app/layout.tsx`.
        </p>
      </section>

      <section className="grid">
        <article className="feature">
          <h2>1. Create a folder</h2>
          <p>`src/app/docs` maps to the `/docs` route.</p>
        </article>
        <article className="feature">
          <h2>2. Add a page</h2>
          <p>Export a default component from `page.tsx`.</p>
        </article>
        <article className="feature">
          <h2>3. Share a layout</h2>
          <p>The root layout owns document markup, navigation, and global styles.</p>
        </article>
      </section>
    </>
  );
}
