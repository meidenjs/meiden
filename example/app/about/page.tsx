export default function AboutPage() {
  return (
    <div className="page-head">
      <h1>About Meiden</h1>
      <p className="lead">
        Meiden is a minimal React framework built for Bun. It focuses on 
        simplicity, speed, and automatic island hydration.
      </p>
      <div className="grid" style={{ marginTop: "40px" }}>
        <article className="feature">
          <h2>Philosophy</h2>
          <p>
            We believe that the best web framework is the one that stays 
            out of your way and lets you build beautiful interfaces with ease.
          </p>
        </article>
        <article className="feature">
          <h2>Tech Stack</h2>
          <p>
            Built on top of Bun, React, and Elysia, Meiden leverages the 
            latest advancements in the JavaScript ecosystem.
          </p>
        </article>
      </div>
    </div>
  );
}
