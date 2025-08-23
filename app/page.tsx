'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Centered card on black background:
 *  - Left: hero + CTA + three voice cards
 *  - Right: Conversation (scrolling logs)
 *  - Bottom-right row: Start / Stop (quick demo controls)
 * Advanced controls (echo/ping buttons + states) remain in a <details> block.
 * Tailwind is loaded via CDN in app/layout.tsx (no PostCSS).
 */

type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogLine = { t: string; level: LogLevel; msg: string };

const VOICES = [
  { id: '1', name: 'Voice 1', src: '/voices/voice1.png' },
  { id: '2', name: 'Voice 2', src: '/voices/voice2.png' },
  { id: '3', name: 'Voice 3', src: '/voices/voice3.png' },
] as const;

// circular SVG avatar fallback (used if /public/voices/*.png are missing)
const FALLBACK_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#00e5a8" offset="0"/>
          <stop stop-color="#24c1ff" offset="1"/>
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="128" fill="url(#g)"/>
      <circle cx="128" cy="110" r="44" fill="#000" opacity="0.85"/>
      <rect x="64" y="158" width="128" height="46" rx="23" fill="#000" opacity="0.85"/>
    </svg>`
  );

export default function Page() {
  // --- UI state
  const [voiceId, setVoiceId] = useState<'1' | '2' | '3'>('2');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [connected, setConnected] = useState(false);

  // --- logs
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const pushLog = (level: LogLevel, msg: string) => {
    const now = new Date();
    setLogs((prev) => [...prev, { t: now.toLocaleTimeString(), level, msg }]);
  };
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // --- ws refs
  const echoRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<WebSocket | null>(null);

  // --- ws base (client-only)
  const wsBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }, []);

  // --- echo
  const connectEcho = () => {
    if (!wsBase) return;
    echoRef.current?.close();
    const url = `${wsBase}/ws-echo`;
    const ws = new WebSocket(url);
    echoRef.current = ws;

    ws.onopen = () => pushLog('ok', `[echo] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[echo] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'} `);
    ws.onerror = (e: any) => pushLog('error', `[echo] error: ${e?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[echo] closed`);
  };

  const sendEcho = () => {
    const ws = echoRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushLog('warn', '[echo] not connected');
      return;
    }
    const payload = JSON.stringify({ type: 'hello', voiceId, voiceEnabled });
    ws.send(payload);
    pushLog('info', `[echo] sent → ${payload}`);
  };

  const closeEcho = () => {
    echoRef.current?.close();
    echoRef.current = null;
  };

  // --- ping
  const connectPing = () => {
    if (!wsBase) return;
    pingRef.current?.close();
    const url = `${wsBase}/ws-ping`;
    const ws = new WebSocket(url);
    pingRef.current = ws;

    ws.onopen = () => pushLog('ok', `[ping] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[ping] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'}`);
    ws.onerror = (e: any) => pushLog('error', `[ping] error: ${e?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[ping] closed`);
  };

  const closePing = () => {
    pingRef.current?.close();
    pingRef.current = null;
  };

  // --- combined
  const startSmokeTest = () => {
    connectEcho();
    connectPing();
    setConnected(true);
    setTimeout(() => sendEcho(), 200); // first hello
  };

  const stopSmokeTest = () => {
    closeEcho();
    closePing();
    setConnected(false);
  };

  // --- ui helpers
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
      {/* Centered card wrapper */}
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <div className="relative rounded-3xl border border-neutral-800 bg-neutral-900/40 p-6 shadow-2xl sm:p-8 md:p-10">
          {/* Title bar */}
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 font-semibold">C</div>
              <div className="text-sm leading-tight">
                <div className="font-semibold tracking-wide">CASE CONNECT</div>
                <div className="text-neutral-400">Demo</div>
              </div>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs ${connected ? 'bg-emerald-600/90' : 'bg-neutral-800'}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* Inner grid: hero left, conversation right */}
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.15fr_1fr]">
            {/* LEFT */}
            <section className="space-y-8">
              {/* hero */}
              <div className="space-y-6">
                <h1 className="text-4xl font-extrabold leading-tight text-amber-300 sm:text-5xl">
                  Demo our AI intake experience
                </h1>
                <p className="max-w-prose text-lg text-neutral-300">
                  Speak with our virtual assistant and experience a legal intake done right.
                </p>

                <div className="pt-2">
                  <button
                    onClick={startSmokeTest}
                    className="rounded-full bg-amber-500 px-6 py-3 text-lg font-semibold text-black shadow hover:bg-amber-400"
                  >
                    Speak with AI Assistant
                  </button>
                </div>
              </div>

              {/* voices */}
              <div className="space-y-5">
                <h3 className="text-xl font-semibold text-amber-100">Choose a voice to sample</h3>

                <div className="grid grid-cols-3 gap-4">
                  {VOICES.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setVoiceId(v.id as '1' | '2' | '3')}
                      className={`group relative overflow-hidden rounded-2xl border transition
                        ${
                          voiceId === v.id
                            ? 'border-amber-400/80 bg-amber-400/10'
                            : 'border-neutral-800 bg-neutral-900/40 hover:bg-neutral-800'
                        }`}
                    >
                      <div className="flex flex-col items-center gap-2 p-4">
                        <div className="relative h-28 w-28 rounded-full ring-2 ring-cyan-400/60">
                          <img
                            src={v.src}
                            alt={v.name}
                            className="h-28 w-28 rounded-full object-cover"
                            onError={(e) => {
                              const t = e.currentTarget as HTMLImageElement;
                              if (t.src !== FALLBACK_DATA_URI) t.src = FALLBACK_DATA_URI;
                            }}
                          />
                        </div>
                        <div className="pb-1 text-sm text-amber-100">{v.name}</div>
                      </div>
                    </button>
                  ))}
                </div>

                {/* voice toggle (like the mock) */}
                <div className="mt-1 flex items-center gap-3 pl-1 text-neutral-300">
                  <span className="text-base">Voice</span>
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={voiceEnabled}
                      onChange={(e) => setVoiceEnabled(e.target.checked)}
                    />
                    <div className="peer h-6 w-12 rounded-full bg-neutral-700 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-amber-500 peer-checked:after:translate-x-6" />
                  </label>
                </div>

                {/* Advanced smoke controls */}
                <details className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 open:pb-5">
                  <summary className="cursor-pointer text-sm text-neutral-300">
                    Advanced: WebSocket smoke controls
                  </summary>

                  <div className="mt-3 flex flex-wrap gap-3">
                    <button onClick={startSmokeTest} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500">
                      Start
                    </button>
                    <button onClick={stopSmokeTest} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium hover:bg-rose-500">
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
            </section>

            {/* RIGHT — Conversation */}
            <section>
              <div className="flex h-[60vh] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/60 shadow-lg">
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
              </div>
            </section>
          </div>

          {/* Bottom-right quick controls inside the card */}
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={startSmokeTest}
              className="rounded-xl bg-amber-500 px-5 py-2 font-semibold text-black hover:bg-amber-400"
            >
              Start
            </button>
            <button
              onClick={stopSmokeTest}
              className="rounded-xl bg-neutral-800 px-5 py-2 font-semibold hover:bg-neutral-700"
            >
              Stop
            </button>
          </div>
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
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${map[level]}`}>
      {level.toUpperCase()}
    </span>
  );
}
