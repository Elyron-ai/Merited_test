import type { ReactNode } from 'react';

// W15/#36 (SC 2.4.2): a title TEMPLATE so each route contributes its own name
// ("Linked accounts · Merited Wallet") instead of every screen sharing one title.
export const metadata = {
  title: { default: 'Merited Wallet', template: '%s · Merited Wallet' },
};

/** Dark mode, green accent (PH2-3 row) — deliberately plain markup like the
 * control plane: every screen exists to PROVE one thing on camera. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body
        style={{
          background: '#0b0f0d',
          color: '#e6f2ea',
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          padding: '1.5rem',
        }}
      >
        <style>{`
          a { color: #34d399; }
          h1, h2 { color: #a7f3d0; }
          table { border-collapse: collapse; }
          td, th { border-bottom: 1px solid #1f2a24; }
          button { background: #065f46; color: #e6f2ea; border: 1px solid #34d399; border-radius: 0.3rem; padding: 0.3rem 0.8rem; cursor: pointer; }
          /* W14/#18 (SC 1.4.11): the input boundary was #1f2a24 on #0b0f0d — ~1.23:1,
             so fields were nearly invisible. #5f8873 is ~4.59:1 vs the fill and
             ~4.83:1 vs the page (measured), clearing the 3:1 non-text minimum. */
          input, select { background: #101613; color: #e6f2ea; border: 1px solid #5f8873; border-radius: 0.3rem; padding: 0.3rem; }
          code { color: #6ee7b7; }
          /* W15 (SC 2.4.7/2.4.11): an explicit, high-contrast focus ring — the
             UA default is unreliable on this dark theme. #6ee7b7 is bright green,
             well over 3:1 against the page. */
          :focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
          /* W15 (SC 2.4.1): skip-to-content link — off-screen until focused. */
          a.skip-link { position: absolute; left: -9999px; top: 0; background: #065f46; color: #e6f2ea; padding: 0.5rem 0.75rem; border: 1px solid #34d399; border-radius: 0 0 0.3rem 0; z-index: 1000; }
          a.skip-link:focus { left: 0; }
        `}</style>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
