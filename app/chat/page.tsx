'use client';

import Link from 'next/link';

export default function ChatPage() {
  return (
    <main className="min-h-screen bg-black text-neutral-100">
      <div className="mx-auto w-full max-w-[1150px] px-4 py-6">
        <div className="relative rounded-[24px] border border-neutral-800/50 bg-[#0b0b0f]/75 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_18px_48px_rgba(0,0,0,0.5)] p-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">
              Case Management Chat
            </h1>
            <div className="flex items-center gap-3">
              {/* We’ll wire real connection state later; placeholder for now */}
              <span className="rounded-full bg-neutral-800/80 px-3 py-1 text-xs">
                Disconnected
              </span>
              <Link
                href="/"
                className="rounded-xl bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
              >
                ← Back
              </Link>
            </div>
          </div>

          {/* Intentionally blank shell for Step 0 */}
          <div className="mt-8 grid min-h-[480px] place-items-center rounded-xl border border-neutral-800/60">
            <p className="text-neutral-400">
              Chat shell coming next — this page is intentionally blank for Step 0.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
