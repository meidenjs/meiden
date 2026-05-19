import ThemeToggle from "./components/ThemeToggle";

export default function RootLayout({ children }: { children: any }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Meiden Studio</title>
        <style>{`
          :root {
            color: #17201b;
            background: #f7f8f4;
            font-family:
              Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
              "Segoe UI", sans-serif;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            min-width: 320px;
            min-height: 100vh;
            background:
              radial-gradient(circle at 18% 8%, rgba(116, 154, 132, 0.18), transparent 30rem),
              linear-gradient(180deg, #fbfcf7 0%, #eef2e9 100%);
          }

          a {
            color: inherit;
            text-decoration: none;
          }

          .shell {
            width: min(1120px, calc(100% - 40px));
            margin: 0 auto;
          }

          .nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 20px;
            padding: 22px 0;
          }

          .brand {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            font-size: 15px;
            font-weight: 750;
          }

          .mark {
            display: grid;
            width: 32px;
            height: 32px;
            place-items: center;
            border: 1px solid rgba(23, 32, 27, 0.14);
            border-radius: 8px;
            background: #17201b;
            color: #f8f4e8;
          }

          .links {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .links a {
            border-radius: 8px;
            padding: 8px 11px;
            color: #516056;
            font-size: 14px;
            font-weight: 650;
          }

          .links a:hover {
            background: rgba(23, 32, 27, 0.06);
            color: #17201b;
          }

          main {
            padding: 34px 0 56px;
          }

          .hero {
            display: grid;
            grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr);
            gap: 36px;
            align-items: center;
            min-height: calc(100vh - 170px);
          }

          .eyebrow {
            margin: 0 0 14px;
            color: #667268;
            font-size: 13px;
            font-weight: 760;
            letter-spacing: 0;
            text-transform: uppercase;
          }

          h1 {
            max-width: 760px;
            margin: 0;
            color: #17201b;
            font-size: clamp(48px, 8vw, 92px);
            line-height: 0.94;
            letter-spacing: 0;
          }

          .lead {
            max-width: 620px;
            margin: 22px 0 0;
            color: #546158;
            font-size: 19px;
            line-height: 1.65;
          }

          .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 30px;
          }

          .button {
            display: inline-flex;
            min-height: 44px;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            padding: 0 18px;
            font-weight: 760;
          }

          .button.primary {
            background: #17201b;
            color: #f8f4e8;
          }

          .button.secondary {
            border: 1px solid rgba(23, 32, 27, 0.16);
            background: rgba(255, 255, 255, 0.58);
            color: #273129;
          }

          .counter {
            min-height: 44px;
            border: 1px solid rgba(23, 32, 27, 0.16);
            border-radius: 8px;
            background: #ffffff;
            color: #17201b;
            padding: 0 18px;
            font: inherit;
            font-weight: 760;
            cursor: pointer;
          }

          .counter:hover {
            background: #eef3e8;
          }

          .panel {
            border: 1px solid rgba(23, 32, 27, 0.1);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.72);
            box-shadow: 0 24px 80px rgba(41, 53, 45, 0.12);
            overflow: hidden;
          }

          .panel-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid rgba(23, 32, 27, 0.08);
            padding: 14px 16px;
            color: #667268;
            font-size: 13px;
            font-weight: 720;
          }

          .dots {
            display: flex;
            gap: 7px;
          }

          .dots span {
            width: 9px;
            height: 9px;
            border-radius: 999px;
            background: #d8ded3;
          }

          .preview {
            padding: 18px;
          }

          .route-list {
            display: grid;
            gap: 10px;
          }

          .route {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            border: 1px solid rgba(23, 32, 27, 0.08);
            border-radius: 8px;
            background: #fbfcf7;
            padding: 14px;
          }

          .route strong {
            display: block;
            color: #17201b;
            font-size: 15px;
          }

          .route span {
            color: #68736b;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 13px;
          }

          .badge {
            flex: 0 0 auto;
            border-radius: 999px;
            background: #dce8ce;
            color: #334331;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 780;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 14px;
            margin-top: 26px;
          }

          .feature {
            border: 1px solid rgba(23, 32, 27, 0.1);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.64);
            padding: 18px;
          }

          .feature h2 {
            margin: 0 0 8px;
            color: #17201b;
            font-size: 18px;
          }

          .feature p {
            margin: 0;
            color: #59655d;
            line-height: 1.55;
          }

          .hook-gallery {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
            margin-top: 16px;
          }

          .hook-card {
            display: grid;
            gap: 8px;
            min-height: 120px;
            align-content: start;
            border: 1px solid rgba(23, 32, 27, 0.1);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.68);
            padding: 16px;
          }

          .hook-card strong {
            color: #17201b;
            font-size: 15px;
          }

          .hook-card span {
            color: #59655d;
            font-size: 14px;
            line-height: 1.45;
          }

          .hook-card button,
          .hook-card input {
            min-height: 36px;
            border: 1px solid rgba(23, 32, 27, 0.16);
            border-radius: 8px;
            background: #ffffff;
            color: #17201b;
            padding: 0 12px;
            font: inherit;
          }

          .hook-card button {
            cursor: pointer;
            font-weight: 720;
          }

          .page-head {
            max-width: 760px;
            padding: 70px 0 28px;
          }

          .page-head h1 {
            font-size: clamp(42px, 6vw, 72px);
          }

          @media (max-width: 820px) {
            .shell {
              width: min(100% - 28px, 1120px);
            }

            .nav {
              align-items: flex-start;
              flex-direction: column;
            }

            .hero {
              grid-template-columns: 1fr;
              min-height: auto;
            }

            .grid {
              grid-template-columns: 1fr;
            }

            .hook-gallery {
              grid-template-columns: 1fr;
            }
          }
        `}</style>
      </head>
      <body style={{overflowY: "scroll"}}>
        <div className="shell">
          <nav className="nav">
            <a className="brand" href="/">
              <span className="mark">M</span>
              <span>Meiden Studio</span>
            </a>
            <div className="links">
              <a href="/">Home</a>
              <a href="/about">About</a>
              <ThemeToggle />
            </div>
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
