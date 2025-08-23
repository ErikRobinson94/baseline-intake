'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Centered, shorter card; hero stack is centered;
 * voice cards are full-bleed rectangle tiles (no circular crop).
 * Tailwind via CDN from layout.tsx. No PostCSS required.
 */

type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogLine = { t: string; level: LogLevel; msg: string };

const VOICES = [
  { id: '1', name: 'Voice 1', src: '/voices/voice1.png' },
  { id: '2', name: 'Voice 2', src: '/voices/voice2.png' },
  { id: '3', name: 'Voice 3', src: '/voices/voice3.png' },
] as const;

// rectangular fallback artwork
const FALLBACK_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#00e5a8"/>
          <stop offset="1" stop-color="#24c1ff"/>
        </linearGradient>
      </defs>
      <rect width="640" height="800" rx="16" fill="#000"/>
      <rect x="16" y="16" width="608" height="768" rx="16" fill="url(#g)" opacity="0.15"/>
    </svg>`
  );

export default function Page() {
  // ---------- UI state
  const [voiceId, setVoiceId] = useState<'1' | '2' | '3'>('2');
  const [connected, setConnected] = useState(false);

  // ---------- logs
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const pushLog = (level: LogLevel, msg: string) =>
    setLogs((prev) => [...prev, { t: new Date().toLocaleTimeString(), level, msg }]); // ← fixed

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ---------- ws
  const echoRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<WebSocket | null>(null);
  const wsBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }, []);

  const connectEcho = () => {
    if (!wsBase) return;
    echoRef.current?.close();
    const url = `${wsBase}/ws-echo`;
    const ws = new WebSocket(url);
    echoRef.current = ws;
    ws.onopen = () => pushLog('ok', `[echo] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[echo] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'}`);
    ws.onerror = (e: any) => pushLog('error', `[echo] error: ${e?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[echo] closed`);
  };

  const sendEcho = () => {
    const ws = echoRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushLog('warn', '[echo] not connected');
      return;
    }
    const payload = JSON.stringify({ type: 'hello', voiceId });
    ws.send(payload);
    pushLog('info', `[echo] sent → ${payload}`);
  };

  const connectPing = () => {
    if (!wsBase) return;
    pingRef.current?.close();
    const url = `${wsBase}/ws-ping`;
    const ws = new WebSocket(url);
    pingRef.current = ws;
    ws.onopen = () => pushLog('ok', `[ping] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[ping] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'} (pong)`);
    ws.onerror = (e: any) => pushLog('error', `[ping] error: ${e?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[ping] closed`);
  };

  const start = () => {
    connectEcho();
    connectPing();
    setConnected(true);
    setTimeout(() => sendEcho(), 200);
  };

  const stop = () => {
    echoRef.current?.close();
    pingRef.current?.close();
    echoRef.current = null;
    pingRef.current = null;
    setConnected(false);
  };

  const echoState = echoRef.current?.readyState;
  const pingState = pingRef.current?.readyState;
  const readyLabel = (rs?: number) =>
    rs === WebSocket.OPEN
      ? 'OPEN'
      : rs === WebSocket.CONNECTING
      ? 'CONNECTING'
      : rs === WebSocket.CLOSING
      ? 'CLOSING'
      : rs === WebSocket.CLOSED
      ? 'CLOSED'
      : '—';

  return (
    <main className="min-h-screen bg-black text-neutral-100">
      {/* SHORT, WIDE CENTERED CARD */}
      <div className="mx-auto w-full max-w-[1200px] px-4 py-8">
        <div className="relative rounded-[28px] border border-neutral-800/80 bg-[#0b0b0f]/75 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_20px_60px_rgba(0,0,0,0.55)]">
          <div
            className="pointer-events-none absolute inset-0 rounded-[28px] opacity-35"
            style={{
              background:
                'radial-gradient(900px 300px at -150px -80px, rgba(255,199,0,0.08), transparent 60%), radial-gradient(900px 300px at 120% 0, rgba(0,180,255,0.08), transparent 60%)',
            }}
          />

          {/* HEADER ROW */}
          <div className="relative flex items-center justify-between px-8 pt-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 font-semibold">C</div>
              <div className="text-sm leading-tight">
                <div className="font-semibold tracking-wide">CASE CONNECT</div>
                <div className="text-neutral-400">Demo</div>
              </div>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs ${connected ? 'bg-emerald-600/90' : 'bg-neutral-800/80'}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* GRID: HERO + CONVERSATION */}
          <div className="relative grid grid-cols-1 gap-6 px-8 pb-6 pt-2 md:grid-cols-[1.25fr_1fr]">
            {/* LEFT — centered stack */}
            <section className="flex flex-col items-center">
              <div className="w-full max-w-[560px] text-center">
                <h1 className="mb-4 text-[46px] font-extrabold leading-tight text-amber-300 sm:text-[58px]">
                  Demo our AI intake experience
                </h1>
                <p className="mx-auto mb-6 max-w-[40ch] text-[18px] text-neutral-300">
                  Speak with our virtual assistant and experience a legal intake done right.
                </p>
                <button
                  onClick={start}
                  className="mx-auto mb-8 inline-flex rounded-full bg-amber-500 px-6 py-3 text-lg font-semibold text-black shadow hover:bg-amber-400"
                >
                  Speak with AI Assistant
                </button>
              </div>

              {/* VOICE GRID: full-bleed tiles */}
              <div className="w-full max-w-[720px]">
                <h3 className="mb-3 text-center text-[20px] font-semibold text-amber-100">
                  Choose a voice to sample
                </h3>
                <div className="grid grid-cols-3 gap-5">
                  {VOICES.map((v) => (
                    <div key={v.id} className="flex flex-col items-center">
                      <button
                        onClick={() => setVoiceId(v.id as '1' | '2' | '3')}
                        className={`group relative aspect-[4/3] w-full overflow-hidden rounded-2xl border transition
                          ${
                            voiceId === v.id
                              ? 'border-amber-400 shadow-[0_0_30px_rgba(255,200,0,0.15)]'
                              : 'border-neutral-800 hover:border-neutral-700'
                          }`}
                        style={{ backgroundColor: '#000' }}
                        aria-label={v.name}
                      >
                        <img
                          src={v.src}
                          alt={v.name}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            const t = e.currentTarget as HTMLImageElement;
                            if (t.src !== FALLBACK_DATA_URI) t.src = FALLBACK_DATA_URI;
                          }}
                        />
                        {voiceId === v.id && (
                          <div className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-amber-400/80" />
                        )}
                      </button>
                      <div className="mt-2 text-sm text-amber-100">{v.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* RIGHT — Conversation */}
            <section className="flex justify-center">
              <div className="flex h-[460px] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-[#121216]/90">
                <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                  <h2 className="text-base font-semibold">Conversation</h2>
                  <span className="text-xs text-neutral-400">
                    {logs.length} {logs.length === 1 ? 'event' : 'events'}
                  </span>
                </header>
                <div className="flex-1 overflow-y-auto px-4 py-3">
                  {logs.length === 0 ? (
                    <p className="select-none text-neutral-400">
                      Click <span className="font-semibold text-amber-300">Speak with AI Assistant</span> to start.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {logs.map((l, i) => (
                        <li key={i} className="font-mono text-xs">
                          <span className="mr-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                            {l.t}
                          </span>
                          <LevelPill level={l.level} />
                          <span className="ml-2 break-words">{l.msg}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div ref={logEndRef} />
                </div>
                <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-400">
                  Echo/ping smoke only. Next: audio worklets → Deepgram.
                </footer>
              </div>
            </section>
          </div>

          {/* Bottom-right quick controls */}
          <div className="relative -mt-1 flex items-center justify-end gap-3 px-8 pb-6">
            <button
              onClick={start}
              className="rounded-xl bg-amber-500 px-5 py-2 font-semibold text-black hover:bg-amber-400"
            >
              Start
            </button>
            <button
              onClick={stop}
              className="rounded-xl bg-neutral-800 px-5 py-2 font-semibold hover:bg-neutral-700"
            >
              Stop
            </button>
          </div>

          {/* Advanced controls */}
          <details className="mx-8 mb-6 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 open:pb-5">
            <summary className="cursor-pointer text-sm text-neutral-300">Advanced smoke controls</summary>
            <div className="mt-3 flex flex-wrap gap-3">
              <button onClick={start} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500">
                Start smoke test
              </button>
              <button onClick={stop} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium hover:bg-rose-500">
                Stop
              </button>
              <button onClick={connectEcho} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">
                Connect echo
              </button>
              <button onClick={sendEcho} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">
                Send echo
              </button>
              <button onClick={connectPing} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">
                Connect ping
              </button>
              <button onClick={() => setLogs([])} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">
                Clear logs
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-neutral-300">
              <div className="rounded-lg border border-neutral-800 p-3">
                <div className="text-neutral-400">/ws-echo</div>
                <div className="mt-1 font-mono text-xs">
                  state: <span className="font-semibold">{readyLabel(echoState)}</span>
                </div>
              </div>
              <div className="rounded-lg border border-neutral-800 p-3">
                <div className="text-neutral-400">/ws-ping</div>
                <div className="mt-1 font-mono text-xs">
                  state: <span className="font-semibold">{readyLabel(pingState)}</span>
                </div>
              </div>
              <a
                href="/healthz"
                target="_blank"
                rel="noreferrer"
                className="col-span-2 inline-flex items-center justify-center rounded-lg border border-neutral-800 px-3 py-2 text-center text-sm font-medium hover:bg-neutral-800"
              >
                Check /healthz
              </a>
            </div>
          </details>
        </div>
      </div>
    </main>
  );
}

function LevelPill({ level }: { level: LogLevel }) {
  const map: Record<LogLevel, string> = {
    info: 'bg-sky-700',
    ok: 'bg-emerald-700',
    warn: 'bg-amber-700',
    error: 'bg-rose-700',
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${map[level]}`}>{level.toUpperCase()}</span>;
}
