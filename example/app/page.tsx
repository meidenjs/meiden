import Counter from "./components/Counter";
import HookGallery from "./components/HookGallery";

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">App router example</p>
          <h1>Build calm full-stack apps with file routes.</h1>
          <p className="lead">
            This example uses the Meiden app directory convention: a root layout
            wraps every page, and each `page.tsx` becomes a route.
          </p>
          <div className="actions">
            <a className="button primary" href="/docs">View route</a>
            <a className="button secondary" href="https://bun.sh">Bun runtime</a>
            <Counter initial={3} />
          </div>
        </div>

        <aside className="panel" aria-label="Route preview">
          <div className="panel-top">
            <span>src/app</span>
            <div className="dots" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
          <div className="preview">
            <div className="route-list">
              <div className="route">
                <div>
                  <strong>Home page</strong>
                  <span>app/page.tsx</span>
                </div>
                <span className="badge">/</span>
              </div>
              <div className="route">
                <div>
                  <strong>Docs page</strong>
                  <span>app/docs/page.tsx</span>
                </div>
                <span className="badge">/docs</span>
              </div>
              <div className="route">
                <div>
                  <strong>Shared shell</strong>
                  <span>app/layout.tsx</span>
                </div>
                <span className="badge">layout</span>
              </div>
            </div>
          </div>
        </aside>
      </section>

      <section className="grid" aria-label="Framework capabilities">
        <article className="feature">
          <h2>Server first</h2>
          <p>Pages render through the dev server today and can grow into server APIs next.</p>
        </article>
        <article className="feature">
          <h2>File routes</h2>
          <p>Folders under `app` map directly to clean URLs with a familiar convention.</p>
        </article>
        <article className="feature">
          <h2>Client ready</h2>
          <p>The same tree gives Meiden a place to add client component lifecycle support.</p>
        </article>
      </section>

      <HookGallery />
    </>
  );
}
