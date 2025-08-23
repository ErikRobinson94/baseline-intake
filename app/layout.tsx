// app/layout.tsx — Root layout using Tailwind CDN (no PostCSS pipeline)
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Baseline — Node + Next.js — Render',
  description: 'WebSocket smoke tests and baseline UI.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Tailwind via CDN to avoid PostCSS config issues */}
        <script src="https://cdn.tailwindcss.com"></script>
        {/* Optional: you can tweak the Tailwind config here if needed */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              tailwind.config = {
                theme: { extend: {} }
              };
            `,
          }}
        />
      </head>
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
