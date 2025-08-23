'use client';

import Image from 'next/image';
import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Left: hero (title/subcopy/CTA) + three voice cards (like your old demo)
 * Right: Conversation panel (scrolling logs)
 * CTA + controls run the same WebSocket smoke tests (/ws-echo and /ws-ping)
 * Tailwind is loaded via CDN in app/layout.tsx (no PostCSS pipeline needed).
 */

type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogLine = { t: string; level: LogLevel; msg: string };

const VOICES = [
  { id: '1', name: 'Voice 1', src: '/voices/voice1.png' },
  { id: '2', name: 'Voice 2', src: '/voices/voice2.png' },
  { id: '3', name: 'Voice 3', src: '/voices/voice3.png' },
] as const;

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
    <main className="min-h-screen bg-[#0b0b0f] text-neutral-100">
      {/* header / brand */}
      <div className="mx-auto w-full max-w-7xl px-6 py-4 md:px-10">
        <div className="flex items-center justify-between">
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
      </div>

      {/* 2-column layout */}
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-8 px-6 pb-12 md:grid-cols-2 md:px-10">
        {/* LEFT — hero + voices */}
        <section className="space-y-8">
          {/* hero */}
          <div className="space-y-6">
            <h1 className="text-5xl font-extrabold leading-tight text-amber-300 sm:text-6xl">
              Demo our AI<br />intake experience
            </h1>
            <p className="max-w-prose text-xl text-neutral-400">
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
            <h3 className="text-2xl font-semibold text-amber-100">Choose a voice to sample</h3>

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
                    <div className="relative h-32 w-32">
                      <Image
                        src={v.src}
                        alt={v.name}
                        fill
                        sizes="128px"
                        className="rounded-full object-cover ring-2 ring-cyan-400/60"
                      />
                    </div>
                    <div className="pb-1 text-sm text-amber-100">{v.name}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* little voice toggle like the mock */}
            <div className="mt-1 flex items-center gap-3 pl-1 text-neutral-300">
              <span className="text-lg">Voice</span>
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

            {/* optional: advanced controls as a collapsible */}
            <details className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 open:pb-5">
              <summary className="cursor-pointer text-sm text-neutral-300">Advanced: WebSocket smoke controls</summary>
              <div className="mt-3 flex flex-wrap gap-3">
                <button onClick={startSmokeTest} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500">Start</button>
                <button onClick={stopSmokeTest} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium hover:bg-rose-500">Stop</button>
                <button onClick={connectEcho} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">Connect echo</button>
                <button onClick={sendEcho} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">Send echo</button>
                <button onClick={connectPing} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">Connect ping</button>
                <button onClick={() => setLogs([])} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700">Clear logs</button>
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
              </div>

              <a href="/healthz" target="_blank" rel="noreferrer" className="mt-3 inline-block rounded-lg border border-neutral-800 px-3 py-2 text-center text-sm font-medium hover:bg-neutral-800">Check /healthz</a>
            </details>
          </div>
        </section>

        {/* RIGHT — Conversation / logs */}
        <section>
          <div className="flex h-[72vh] min-h-[520px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50 shadow-lg">
            <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h2 className="text-lg font-semibold">Conversation</h2>
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
                      <span className="mr-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">{l.t}</span>
                      <LevelPill level={l.level} />
                      <span className="ml-2 break-words">{l.msg}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div ref={logEndRef} />
            </div>

            <footer className="border-t border-neutral-800 px-4 py-3 text-xs text-neutral-400">
              Next: hook up audio worklets → Deepgram. For now, verify echo/ping stability.
            </footer>
          </div>
        </section>
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
