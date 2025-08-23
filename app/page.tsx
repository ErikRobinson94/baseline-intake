'use client';

import React, { useState } from 'react';

type Level = 'info' | 'warn' | 'error';

export default function Page() {
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const add = (level: Level, msg: string, meta?: any) => {
    const t = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const color =
      level === 'error' ? '#f87171' :
      level === 'warn'  ? '#facc15' : '#86efac';
    const line = `%c[${String(t).padStart(6,' ')}] ${msg}${meta ? '  ' + safe(meta) : ''}`;
    // console
    (level === 'error' ? console.error :
     level === 'warn'  ? console.warn  : console.log)(line, `color:${color}`);
    // ui
    setLogs((l) => [...l, line.replace('%c','')]);
  };

  // Only compute WS base **in the browser** and only when Start is clicked.
  const getWSBase = (): string => {
    if (typeof window === 'undefined') return ''; // SSR: never used during build
    const origin = process.env.NEXT_PUBLIC_BACKEND_ORIGIN;
    if (origin) {
      try {
        const u = new URL(origin);
        return `wss://${u.host}`;
      } catch { /* ignore */ }
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  };

  const wsTry = (url: string, opts: {
    name: string;
    expect?: (ev: MessageEvent) => boolean;
    onOpen?: (ws: WebSocket) => void;
    timeoutMS?: number;
  }) => {
    const { name, expect, onOpen, timeoutMS = 4000 } = opts;
    add('info', `[try] ${name} -> ${url}`);
    const started = Date.now();

    return new Promise<void>((resolve, reject) => {
      let done = false;
      let to: any;

      const finish = (ok: boolean, why?: any) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        const dur = Date.now() - started;
        ok ? add('info', `[ok] ${name} in ${dur}ms`)
           : add('error', `[fail] ${name} in ${dur}ms`, why);
        ok ? resolve() : reject(why);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        finish(false, e);
        return;
      }

      to = setTimeout(() => finish(false, new Error(`timeout ${timeoutMS}ms`)), timeoutMS);

      ws.onopen = () => {
        add('info', `[open] ${name}`);
        try { onOpen?.(ws); } catch (e) { finish(false, e); }
      };
      ws.onerror = (e) => finish(false, e);
      ws.onclose = (e) => add('warn', `[close] ${name}`, { code: e.code, reason: e.reason, clean: e.wasClean });
      ws.onmessage = (e) => {
        add('info', `[msg] ${name}`, typeof e.data);
        if (!expect) return;
        try {
          if (expect(e)) finish(true);
        } catch (er) {
          finish(false, er);
        }
      };
    });
  };

  const smoke = async () => {
    if (running) return;
    setRunning(true);
    setLogs([]);
    const base = getWSBase();
    if (!base) { add('warn', 'Not in browser yet; try again.'); setRunning(false); return; }

    add('info', `[smoke] begin`, { base });

    try {
      await wsTry(`${base}/ws-echo`, {
        name: 'ws-echo',
        onOpen: (ws) => ws.send(new Blob([new Uint8Array([1,2,3,4])])),
        expect: () => true,
      });

      await wsTry(`${base}/ws-ping`, {
        name: 'ws-ping',
        expect: (e) => (typeof e.data === 'string' && e.data.toLowerCase().includes('pong')),
        timeoutMS: 6000,
      });

      await wsTry(`${base}/web-demo/ws`, {
        name: 'web-demo',
        expect: () => true,
      });

      add('info', `[smoke] ✅ ALL PASS`);
    } catch (e) {
      add('error', `[smoke] ❌ FAIL`, e);
    } finally {
      add('info', `[smoke] end`);
      setRunning(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', background:'#0b0b0c', color:'#fff', padding:'24px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>WebSocket smoke test</h1>
        <p style={{ opacity: 0.7, fontSize: 14, marginBottom: 16 }}>
          Click Start to run echo / ping / demo checks against your backend.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            onClick={smoke}
            disabled={running}
            style={{
              padding: '10px 16px', borderRadius: 12,
              background: running ? '#999' : '#facc15',
              color: '#000', fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer'
            }}
          >
            {running ? 'Running…' : 'Start (run smoke test)'}
          </button>
          <button
            onClick={() => setLogs([])}
            style={{ padding: '10px 16px', borderRadius: 12, background: '#222', color: '#ddd' }}
          >
            Clear
          </button>
        </div>

        <section style={{ borderRadius: 12, background:'#111', border:'1px solid #222', padding:12 }}>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize:12, lineHeight:'22px', whiteSpace:'pre-wrap' }}>
            {logs.length === 0
              ? <div style={{ color:'#888' }}>Logs will appear here…</div>
              : logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </section>
      </div>
    </main>
  );
}

function safe(x: any) {
  try {
    if (x instanceof Event) return `{Event type="${(x as any).type}"}`;
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
