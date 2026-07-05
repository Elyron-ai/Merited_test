import type { ReactNode } from 'react';

export const metadata = { title: 'Merited Wallet' };

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
          input, select { background: #101613; color: #e6f2ea; border: 1px solid #1f2a24; border-radius: 0.3rem; padding: 0.3rem; }
          code { color: #6ee7b7; }
        `}</style>
        {children}
      </body>
    </html>
  );
}
