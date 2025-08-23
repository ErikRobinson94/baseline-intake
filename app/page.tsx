'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogLine = { t: string; level: LogLevel; msg: string };

export default function Page() {
  // ---------------- state
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [voiceId, setVoiceId] = useState<'1' | '2' | '3'>('2');
  const [connected, setConnected] = useState<boolean>(false);

  const logEndRef = useRef<HTMLDivElement | null>(null);
  const echoRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<WebSocket | null>(null);

  const wsBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const isHttps = window.location.protocol === 'https:';
    const scheme = isHttps ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }, []);

  // --------------- logging helpers
  const pushLog = (level: LogLevel, msg: string) => {
    const now = new Date();
    setLogs((prev) => [...prev, { t: now.toLocaleTimeString(), level, msg }]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const clearLogs = () => setLogs([]);

  // --------------- ws: echo
  const connectEcho = () => {
    if (!wsBase) return;
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
    const payload = JSON.stringify({ type: 'hello', voiceId });
    ws.send(payload);
    pushLog('info', `[echo] sent → ${payload}`);
  };

  const closeEcho = () => {
    echoRef.current?.close();
    echoRef.current = null;
  };

  // --------------- ws: ping
  const connectPing = () => {
    if (!wsBase) return;
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

  // --------------- combined controls
  const startSmokeTest = () => {
    connectEcho();
    connectPing();
    setConnected(true);
    setTimeout(() => sendEcho(), 200);
  };

  const stopSmokeTest = () => {
    closeEcho();
    closePing();
    setConnected(false);
  };

  // --------------- ui helpers
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
      {/* Top bar */}
      <header className="mx-auto w-full max-w-7xl px-6 py-4 md:px-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 font-semibold">
              C
            </div>
            <div className="text-sm leading-tight">
              <div className="font-semibold tracking-wide">CASE CONNECT</div>
              <div className="text-neutral-400">Demo</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                connected ? 'bg-emerald-600/90' : 'bg-neutral-800'
              }`}
            >
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </header>

      {/* Two-pane layout */}
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-8 px-6 pb-12 md:grid-cols-2 md:px-10">
        {/* LEFT */}
        <section>
          <div className="space-y-6">
            <span className="inline-block rounded-full bg-neutral-800 px-3 py-1 text-xs tracking-wide text-neutral-300">
              Baseline · Node + Next.js · Render
            </span>

            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              Voice Intake, done right.
            </h1>
            <p className="max-w-prose text-neutral-300">
              Speak with our virtual assistant and experience a legal intake done right. For now,
              use the smoke tests to verify the WebSocket layer on{' '}
              <span className="font-mono text-neutral-200">/ws-echo</span> and{' '}
              <span className="font-mono text-neutral-200">/ws-ping</span>.
            </p>

            {/* Voice selector */}
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold">Choose a voice to sample</h3>
                <div className="text-xs text-neutral-400">Selected: Voice {voiceId}</div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {(['1', '2', '3'] as const).map((id) => (
                  <button
                    key={id}
                    onClick={() => setVoiceId(id)}
                    className={`group flex flex-col items-center justify-center gap-2 rounded-2xl border p-5 transition
                      ${
                        voiceId === id
                          ? 'border-emerald-500/80 bg-emerald-500/10'
                          : 'border-neutral-800 bg-neutral-900/40 hover:bg-neutral-800'
                      }`}
                  >
                    <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-neutral-800 text-lg font-bold text-neutral-200 group-hover:scale-[1.02]">
                      {id}
                    </div>
                    <div className="text-sm text-neutral-300">Voice {id}</div>
                  </button>
                ))}
              </div>

              {/* Action row */}
              <div className="mt-6 flex items-center justify-between">
                <button
                  onClick={startSmokeTest}
                  className="rounded-xl bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
                >
                  Start demo
                </button>
                <button
                  onClick={stopSmokeTest}
                  className="rounded-xl bg-rose-600 px-4 py-2 font-medium hover:bg-rose-500"
                >
                  Stop
                </button>
              </div>
            </div>

            {/* Smoke test controls block (explicit as in your baseline) */}
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

        {/* RIGHT: Conversation / Logs */}
        <section>
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
                  Logs will appear here. Click <span className="font-semibold">Start demo</span>.
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
