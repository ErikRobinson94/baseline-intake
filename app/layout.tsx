// app/layout.tsx — root layout for Next.js App Router
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Baseline — Node + Next.js — Render',
  description: 'WebSocket smoke tests and baseline UI.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
