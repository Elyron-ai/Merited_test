import type { ReactNode } from 'react';

export const metadata = { title: 'Merited control plane' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: '48rem' }}>
        <style>{`
          /* W15 (SC 2.4.7): an explicit high-contrast focus ring (6.5:1 on white). */
          :focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
          /* W15 (SC 2.4.1): skip-to-content link — off-screen until focused. */
          a.skip-link { position: absolute; left: -9999px; top: 0; background: #1d4ed8; color: #fff; padding: 0.5rem 0.75rem; border-radius: 0 0 0.3rem 0; z-index: 1000; }
          a.skip-link:focus { left: 0; }
        `}</style>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
