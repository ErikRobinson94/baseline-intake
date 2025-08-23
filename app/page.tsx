'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Force runtime rendering; avoid any static caching for `/`
export const dynamic = 'force-dynamic';
export const revalidate = false;

type Log = { t: number; level: 'info' | 'warn' | 'error'; msg: string; meta?: any };

function now() { return Math.round(performance.now()); }
function fmt(ms: number) { return ms.toString().padStart(6, ' '); }

function useLogger() {
  const [logs, setLogs] = useState<Log[]>([]);
  const add = useCallback((level: Log['level'], msg: string, meta?: any) => {
    const entry: Log = { t: now(), level, msg, meta };
    const tag = `[ui ${level}]`;
    if (level === 'error') console.error(tag, msg, meta ?? '');
    else if (level === 'warn') console.warn(tag, msg, meta ?? '');
    else console.log(tag, msg, meta ?? '');
    setLogs((l) => [...l, entry]);
  }, []);
  const clear = useCallback(() => setLogs([]), []);
  return { logs, add, clear };
}

function getWSBase(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

async function wsTry(
  url: string,
  opts: {
    name: string;
    expect?: (ev: MessageEvent) => boolean;
    onOpen?: (ws: WebSocket) => void;
    timeoutMS?: number;
    closeAfter?: number;
    logger: (level: Log['level'], msg: string, meta?: any) => void;
  }
): Promise<void> {
  const { name, onOpen, expect, timeoutMS = 4000, closeAfter = 0, logger } = opts;
  logger('info', `[try] ${name} -> ${url}`);
  const started = now();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let to: any = null;

    const finish = (ok: boolean, why?: any, ws?: WebSocket) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try { ws?.close(); } catch {}
      const dur = now() - started;
      if (ok) logger('info', `[ok] ${name} in ${dur}ms`);
      else logger('error', `[fail] ${name} in ${dur}ms`, why);
      ok ? resolve() : reject(why);
    };

    const ws = new WebSocket(url);

    to = setTimeout(() => finish(false, new Error(`timeout ${timeoutMS}ms`), ws), timeoutMS);

    ws.onopen = () => {
      logger('info', `[open] ${name}`);
      try { onOpen?.(ws); } catch (e) { finish(false, e, ws); }
    };
    ws.onerror = (e) => finish(false, e, ws);
    ws.onmessage = (e) => {
      logger('info', `[msg] ${name}`, typeof e.data);
      if (!expect) { finish(true, null, ws); return; }
      let ok = false;
      try { ok = expect(e); } catch (er) { finish(false, er, ws); return; }
      if (ok) {
        if (closeAfter > 0) setTimeout(() => finish(true, null, ws), closeAfter);
        else finish(true, null, ws);
      }
    };
    ws.onclose = (e) => logger('warn', `[close] ${name}`, { code: e.code, reason: e.reason, clean: e.wasClean });
  });
}

export default function Page() {
  const { logs, add, clear } = useLogger();
  const runningRef = useRef(false);
  const liveWS = useRef<WebSocket | null>(null);

  const [voiceId, setVoiceId] = useState<number>(2);
  const [base, setBase] = useState('');
  useEffect(() => { setBase(getWSBase()); }, []);

  const urls = useMemo(() => {
    if (!base) return null;
    return {
      echo: `${base}/ws-echo`,
      ping: `${base}/ws-ping`,
      demo: (v: number) => `${base}/web-demo/ws?voiceId=${v}`,
    };
  }, [base]);

  const stop = useCallback(() => {
    try { liveWS.current?.close(); } catch {}
    liveWS.current = null;
    add('warn', `Stopped`);
  }, [add]);

  const start = useCallback(async () => {
    if (!urls) { add('warn', 'Waiting for client to mount (no WS base yet)…'); return; }
    if (runningRef.current) return;
    runningRef.current = true;
    clear();
    add('info', `Connecting → ${urls.demo(voiceId)}`);

    try {
      await wsTry(urls.echo, {
        name: 'ws-echo',
        onOpen: (ws) => ws.send(new Blob([new Uint8Array([1,2,3,4])])),
        expect: () => true,
        timeoutMS: 4000,
        closeAfter: 50,
        logger: add,
      });

      await wsTry(urls.ping, {
        name: 'ws-ping',
        expect: (e) => (typeof e.data === 'string' && e.data.toLowerCase().includes('pong')),
        timeoutMS: 6000,
        logger: add,
      });

      const ws = new WebSocket(urls.demo(voiceId));
      liveWS.current = ws;
      ws.onopen = () => add('info', `WS open`);
      ws.onmessage = (e) => {
        const kind = typeof e.data;
        if (kind === 'string') add('info', `msg: "${e.data.slice(0, 120)}"`);
        else add('info', `msg: [${kind}]`);
      };
      ws.onerror = (e) => add('error', `WS error`, e);
      ws.onclose = (e) => add('warn', `WS close code=${e.code} reason="${e.reason}" clean=${e.wasClean}`);
    } catch (e) {
      add('error', `Preflight failed`, e);
    } finally {
      runningRef.current = false;
    }
  }, [urls, voiceId, add, clear]);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* LEFT: hero */}
          <section>
            <div className="flex items-center gap-3 mb-10">
              <div className="h-10 w-10 grid place-items-center rounded-full bg-emerald-400/20 text-emerald-300 font-bold">C</div>
              <div className="leading-tight">
                <div className="text-xl font-semibold">CASE</div>
                <div className="text-xl font-semibold text-emerald-300">CONNECT</div>
              </div>
            </div>

            <h1 className="text-5xl font-extrabold tracking-tight mb-6">
              Demo our AI intake experience
            </h1>
            <p className="text-zinc-300 max-w-prose mb-8">
              Speak with our virtual assistant and experience a legal intake done right.
            </p>

            <div className="flex gap-3 mb-10">
              <button
                onClick={start}
                disabled={!urls}
                className={`px-5 py-2 rounded-xl font-semibold ${
                  !urls
                    ? 'bg-zinc-700 cursor-not-allowed text-zinc-300'
                    : 'bg-amber-400 text-black hover:brightness-95'
                }`}
              >
                Speak with AI Assistant
              </button>
            </div>

            <div className="mb-3 text-sm text-zinc-400">Choose a voice to sample</div>
            <div className="grid grid-cols-3 gap-4">
              {[1,2,3].map((v) => (
                <button
                  key={v}
                  onClick={() => setVoiceId(v)}
                  className={`rounded-2xl border p-6 aspect-square grid place-items-center ${
                    voiceId === v ? 'border-emerald-400 bg-emerald-400/10' : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  <div className="text-3xl font-bold text-emerald-300">{v}</div>
                </button>
              ))}
            </div>

            <div className="mt-6">
              <a href="/" className="text-sm text-emerald-300 hover:underline">WebSocket smoke page →</a>
            </div>
          </section>

          {/* RIGHT: log panel */}
          <section className="rounded-2xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-semibold">Conversation</div>
                <div className="text-xs text-zinc-400">Live transcript.</div>
              </div>
              <div className="flex gap-2">
                <button onClick={stop} className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700">Stop</button>
                <button onClick={start} disabled={!urls} className={`px-4 py-1.5 rounded-lg ${!urls ? 'bg-zinc-700 text-zinc-400' : 'bg-amber-400 text-black hover:brightness-95'}`}>Start</button>
              </div>
            </div>

            <div className="h-[520px] overflow-y-auto rounded-lg bg-black/60 p-3 font-mono text-xs leading-6">
              {logs.length === 0 ? (
                <div className="text-zinc-500">System: click Start to connect…</div>
              ) : (
                logs.map((l, i) => {
                  const color = l.level === 'error' ? 'text-rose-400'
                             : l.level === 'warn'  ? 'text-amber-300'
                             : 'text-emerald-300';
                  return (
                    <div key={i} className={color}>
                      [{fmt(l.t)}] {l.level === 'info' ? '' : `${l.level.toUpperCase()}: `}{l.msg}{l.meta ? `  ${safeMeta(l.meta)}` : ''}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function safeMeta(m: any) {
  try {
    if (m instanceof Event) return `{Event type="${(m as any).type}"}`;
    return JSON.stringify(m);
  } catch { return String(m); }
}
