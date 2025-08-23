'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Two-pane landing:
 * - Left: hero + controls
 * - Right: "Conversation" transcript area that doubles as a log console
 *
 * Keeps the existing smoke tests:
 *  - WS /ws-echo (send text, expect echo)
 *  - WS /ws-ping (server pushes "pong" every ~5s)
 *
 * No SSR hazards: window/location only used inside handlers/effects.
 */

type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogLine = { t: string; level: LogLevel; msg: string };

export default function Page() {
  // ---- log state ----
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const pushLog = (level: LogLevel, msg: string) => {
    const now = new Date();
    setLogs((prev) => [
      ...prev,
      {
        t: now.toLocaleTimeString(),
        level,
        msg,
      },
    ]);
  };

  useEffect(() => {
    // autoscroll to the newest entry
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const clearLogs = () => setLogs([]);

  // ---- ws refs ----
  const echoRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<WebSocket | null>(null);

  // Derive WebSocket base url safely on the client.
  const wsBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const isHttps = window.location.protocol === 'https:';
    const scheme = isHttps ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }, []);

  // ---- echo helpers ----
  const connectEcho = () => {
    if (!wsBase) return;
    // close any existing
    echoRef.current?.close();

    const url = `${wsBase}/ws-echo`;
    const ws = new WebSocket(url);
    echoRef.current = ws;

    ws.onopen = () => pushLog('ok', `[echo] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[echo] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'} `);
    ws.onerror = (ev: any) => pushLog('error', `[echo] error: ${ev?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[echo] closed`);
  };

  const sendEcho = () => {
    const ws = echoRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushLog('warn', '[echo] not connected');
      return;
    }
    const payload = `hello from smoke test @ ${new Date().toISOString()}`;
    ws.send(payload);
    pushLog('info', `[echo] sent → "${payload}"`);
  };

  const closeEcho = () => {
    echoRef.current?.close();
    echoRef.current = null;
  };

  // ---- ping helpers ----
  const connectPing = () => {
    if (!wsBase) return;
    // close any existing
    pingRef.current?.close();

    const url = `${wsBase}/ws-ping`;
    const ws = new WebSocket(url);
    pingRef.current = ws;

    ws.onopen = () => pushLog('ok', `[ping] open → ${url}`);
    ws.onmessage = (ev) =>
      pushLog('ok', `[ping] message ← ${typeof ev.data === 'string' ? ev.data : '[binary]'}`);
    ws.onerror = (ev: any) => pushLog('error', `[ping] error: ${ev?.message ?? 'unknown'}`);
    ws.onclose = () => pushLog('warn', `[ping] closed`);
  };

  const closePing = () => {
    pingRef.current?.close();
    pingRef.current = null;
  };

  // ---- combined controls ----
  const startSmokeTest = () => {
    connectEcho();
    connectPing();
    // send an initial echo after a short tick so OPEN has time to fire
    setTimeout(() => sendEcho(), 200);
  };

  const stopSmokeTest = () => {
    closeEcho();
    closePing();
  };

  // Basic connection indicators
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
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* max width wrapper */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 md:flex-row md:gap-8 md:p-10">
        {/* LEFT: HERO */}
        <section className="md:w-1/2">
          <div className="space-y-6">
            <div>
              <span className="inline-block rounded-full bg-neutral-800 px-3 py-1 text-xs tracking-wide text-neutral-300">
                Baseline · Node + Next.js · Render
              </span>
              <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
                Voice Intake, done right.
              </h1>
              <p className="mt-3 max-w-prose text-neutral-300">
                This is the baseline shell we’ll extend with audio worklets and a Deepgram bridge.
                For now, use the smoke tests to verify the WebSocket layer on{' '}
                <span className="font-mono text-neutral-200">
                  /ws-echo
                </span>{' '}
                and{' '}
                <span className="font-mono text-neutral-200">
                  /ws-ping
                </span>
                .
              </p>
            </div>

            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
              <h2 className="mb-3 text-lg font-semibold">Smoke test controls</h2>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={startSmokeTest}
                  className="rounded-lg bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
                >
                  Start smoke test
                </button>
                <button
                  onClick={stopSmokeTest}
                  className="rounded-lg bg-rose-600 px-4 py-2 font-medium hover:bg-rose-500"
                >
                  Stop
                </button>
                <button
                  onClick={connectEcho}
                  className="rounded-lg bg-neutral-800 px-4 py-2 font-medium hover:bg-neutral-700"
                >
                  Connect echo
                </button>
                <button
                  onClick={sendEcho}
                  className="rounded-lg bg-neutral-800 px-4 py-2 font-medium hover:bg-neutral-700"
                >
                  Send echo
                </button>
                <button
                  onClick={connectPing}
                  className="rounded-lg bg-neutral-800 px-4 py-2 font-medium hover:bg-neutral-700"
                >
                  Connect ping
                </button>
                <button
                  onClick={clearLogs}
                  className="rounded-lg bg-neutral-800 px-4 py-2 font-medium hover:bg-neutral-700"
                >
                  Clear logs
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-neutral-300">
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
                  className="col-span-2 mt-1 inline-flex items-center justify-center rounded-lg border border-neutral-800 px-3 py-2 text-center font-medium hover:bg-neutral-800"
                  href="/healthz"
                  target="_blank"
                  rel="noreferrer"
                >
                  Check /healthz
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: CONVERSATION / LOGS */}
        <section className="md:w-1/2">
          <div className="flex h-[70vh] min-h-[480px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50">
            <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h2 className="text-lg font-semibold">Conversation</h2>
              <span className="text-xs text-neutral-400">
                {logs.length} {logs.length === 1 ? 'event' : 'events'}
              </span>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {logs.length === 0 ? (
                <p className="select-none text-neutral-400">
                  Logs will appear here. Click <span className="font-semibold">Start smoke test</span>.
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

            <footer className="border-t border-neutral-800 px-4 py-3 text-xs text-neutral-400">
              Next step: wire audio worklets → Deepgram bridge. For now, verify echo/ping stability.
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
