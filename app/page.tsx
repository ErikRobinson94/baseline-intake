'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';

type Log = { t: number; level: 'info' | 'warn' | 'error'; msg: string; meta?: any };
function now() { return Math.round(performance.now()); }
function fmt(ms: number) { return ms.toString().padStart(6, ' '); }

function useLogger() {
  const [logs, setLogs] = useState<Log[]>([]);
  const add = useCallback((level: Log['level'], msg: string, meta?: any) => {
    const entry: Log = { t: now(), level, msg, meta };
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[ui ${level}]`, msg, meta ?? '');
    setLogs((l) => [...l, entry]);
  }, []);
  const clear = useCallback(() => setLogs([]), []);
  return { logs, add, clear };
}

function getWSBase(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
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
    const ws = new WebSocket(url);

    const finish = (ok: boolean, why: any) => {
      if (done) return;
      done = true;
      const dur = now() - started;
      if (ok) logger('info', `[ok] ${name} in ${dur}ms`);
      else logger('error', `[fail] ${name} in ${dur}ms`, why);
      try { ws.close(); } catch {}
      ok ? resolve() : reject(why);
    };

    const to = setTimeout(() => finish(false, new Error(`timeout ${timeoutMS}ms`)), timeoutMS);

    ws.onopen = () => {
      logger('info', `[open] ${name}`);
      try { onOpen?.(ws); } catch (e) { clearTimeout(to); finish(false, e); }
    };
    ws.onerror = (e) => { clearTimeout(to); finish(false, e); };
    ws.onmessage = (e) => {
      logger('info', `[msg] ${name}`, typeof e.data === 'string' ? 'string' : 'object');
      if (!expect) return;
      let ok = false;
      try { ok = expect(e); } catch (er) { clearTimeout(to); finish(false, er); return; }
      if (ok) {
        if (closeAfter > 0) setTimeout(() => { clearTimeout(to); finish(true, null); }, closeAfter);
        else { clearTimeout(to); finish(true, null); }
      }
    };
    ws.onclose = (e) => logger('warn', `[close] ${name}`, { code: e.code, reason: e.reason, clean: e.wasClean });
  });
}

export default function Page() {
  const { logs, add, clear } = useLogger();
  const runningRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [voiceId, setVoiceId] = useState<number>(2);

  const base = useMemo(() => getWSBase(), []);
  const urls = useMemo(() => ({
    echo: `${base}/ws-echo`,
    ping: `${base}/ws-ping`,
    demo: (v: number) => `${base}/web-demo/ws?voiceId=${v}`,
  }), [base]);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    clear();
    add('info', `Connecting…`, { to: urls.demo(voiceId) });

    try {
      // Preflight: echo + ping
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
        expect: (e) => typeof e.data === 'string' && e.data.toLowerCase().includes('pong'),
        timeoutMS: 6000,
        logger: add,
      });

      // Live demo socket – keep open
      const w = new WebSocket(urls.demo(voiceId));
      wsRef.current = w;

      w.onopen = () => {
        add('info', 'System: connected', { url: urls.demo(voiceId) });
        try { w.send('hello'); } catch {}
      };
      w.onerror = (e) => add('error', '[web-demo] ws error', e);
      w.onclose = (e) => {
        add('warn', 'System: WS close', { code: e.code, reason: e.reason, clean: e.wasClean });
        runningRef.current = false;
      };
      w.onmessage = (e) => {
        const isString = typeof e.data === 'string';
        add('info', '[web-demo] msg', isString ? e.data : '{binary}');
      };

      // Optional: start a gentle timer sending "ping" text; audio can be added later
      const iv = setInterval(() => { try { w.send('ping'); } catch {} }, 8000);
      // store timer on ref so Stop can clear (quick-n-dirty)
      (w as any)._interval = iv;

    } catch (e) {
      add('error', 'System: preflight failed', e);
      runningRef.current = false;
    }
  }, [urls, voiceId, add, clear]);

  const stop = useCallback(() => {
    const w = wsRef.current;
    if (w) {
      try { w.send('bye'); } catch {}
      try { clearInterval((w as any)._interval); } catch {}
      try { w.close(1000, 'user stop'); } catch {}
    }
    wsRef.current = null;
    runningRef.current = false;
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-7xl px-6 py-10 grid grid-cols-1 md:grid-cols-2 gap-10">
        {/* Left: hero */}
        <section>
          <div className="flex items-center gap-3 mb-8">
            <div className="h-10 w-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-300 font-bold">C</div>
            <div>
              <div className="text-emerald-300 font-semibold leading-tight">CASE</div>
              <div className="text-emerald-400 font-semibold -mt-1">CONNECT</div>
            </div>
          </div>

          <h1 className="text-5xl font-extrabold tracking-tight mb-4">Demo our AI intake experience</h1>
          <p className="text-zinc-400 max-w-xl mb-8">
            Speak with our virtual assistant and experience a legal intake done right.
          </p>

          <div className="flex gap-3 mb-8">
            <button onClick={start} className="px-5 py-2 rounded-xl bg-amber-400 text-black font-semibold hover:brightness-95">Speak with AI Assistant</button>
            <button onClick={stop} className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700">Stop</button>
          </div>

          <div className="mb-3 text-zinc-400">Choose a voice to sample</div>
          <div className="flex gap-6">
            {[1,2,3].map(v => (
              <button
                key={v}
                onClick={() => setVoiceId(v)}
                className={`w-28 h-28 rounded-2xl border ${voiceId===v?'border-emerald-400 bg-emerald-400/10':'border-zinc-700 bg-zinc-900'} flex items-center justify-center text-2xl`}
              >
                {v}
              </button>
            ))}
          </div>
        </section>

        {/* Right: console */}
        <section className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 h-[70vh] overflow-auto">
          <div className="text-lg font-semibold mb-2">Conversation</div>
          <div className="text-sm text-zinc-400 mb-3">Live transcript.</div>
          <div className="font-mono text-xs leading-6 whitespace-pre-wrap">
            {logs.length === 0
              ? <div className="text-zinc-500">Press “Speak with AI Assistant” to start. Echo & ping preflight will run first.</div>
              : logs.map((l, i) => {
                  const color = l.level === 'error' ? 'text-red-400'
                               : l.level === 'warn' ? 'text-amber-300'
                               : 'text-green-300';
                  return <div key={i} className={color}>[{fmt(l.t)}] {l.msg}{l.meta ? `  ${safeMeta(l.meta)}` : ''}</div>;
                })}
          </div>
        </section>
      </div>
    </main>
  );
}

function safeMeta(m: any) {
  try { if (m instanceof Event) return `{Event type="${(m as any).type}"}`; return JSON.stringify(m); }
  catch { return String(m); }
}
