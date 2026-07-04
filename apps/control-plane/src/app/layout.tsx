import type { ReactNode } from 'react';

export const metadata = { title: 'Merited control plane' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: '48rem' }}>
        {children}
      </body>
    </html>
  );
}
