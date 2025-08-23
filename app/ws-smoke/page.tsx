'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';

type Log = { t: number; level: 'info' | 'warn' | 'error'; msg: string; meta?: any };

const now = () => Math.round(performance.now());
const fmt = (ms: number) => ms.toString().padStart(6, ' ');

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
  if (typeof window !== 'undefined') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }
  return '';
}

async function wsTry(url: string, opts: any): Promise<void> {
  const {
    name,
    onOpen,
    expect,
    timeoutMS = 4000,
    closeAfter = 0,
    logger,
  } = opts;

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
      logger('info', `[msg] ${name}`, typeof e.data);
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
  const base = useMemo(() => getWSBase(), []);
  const urls = useMemo(() => ({
    echo: `${base}/ws-echo`,
    ping: `${base}/ws-ping`,
    demo: `${base}/web-demo/ws`,
  }), [base]);

  const smoke = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    clear();
    add('info', `[smoke] begin`, { base });

    try {
      await wsTry(urls.echo, {
        name: 'ws-echo',
        onOpen: (ws: WebSocket) => ws.send(new Blob([new Uint8Array([1, 2, 3, 4])])),
        expect: () => true,
        timeoutMS: 4000,
        closeAfter: 50,
        logger: add,
      });

      await wsTry(urls.ping, {
        name: 'ws-ping',
        expect: (e: MessageEvent) =>
          typeof e.data === 'string' && e.data.toLowerCase().includes('pong'),
        timeoutMS: 6000,
        logger: add,
      });

      await wsTry(urls.demo, {
        name: 'web-demo',
        expect: (e: MessageEvent) => typeof e.data === 'string',
        timeoutMS: 4000,
        logger: add,
      });

      add('info', `[smoke] ✅ ALL PASS`);
    } catch (e) {
      add('error', `[smoke] ❌ FAIL`, e);
    } finally {
      add('info', `[smoke] end`);
      runningRef.current = false;
    }
  }, [urls, add, clear]);

  return (
    <main className="min-h-screen p-6" style={{ background: '#0b0b0b', color: 'white' }}>
      <div className="max-w-5xl mx-auto" style={{ display: 'grid', gap: '1rem' }}>
        <h1 style={{ fontSize: 32, fontWeight: 800 }}>WebSocket smoke test</h1>
        <p style={{ color: '#aaa' }}>
          Click Start to run echo / ping / demo checks against your backend.
        </p>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={smoke}
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: '#facc15',
              color: '#111',
              fontWeight: 700,
            }}
          >
            Start (run smoke test)
          </button>
          <button
            onClick={clear}
            style={{ padding: '10px 14px', borderRadius: 12, background: '#27272a', color: 'white' }}
          >
            Clear
          </button>
        </div>

        <section style={{ border: '1px solid #27272a', background: '#18181b', borderRadius: 12, padding: 12 }}>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              lineHeight: '1.6',
            }}
          >
            {logs.length === 0 ? (
              <div style={{ color: '#71717a' }}>Logs will appear here…</div>
            ) : (
              logs.map((l, i) => {
                const color = l.level === 'error' ? '#fca5a5' : l.level === 'warn' ? '#fde68a' : '#86efac';
                const meta = l.meta ? `  ${safeMeta(l.meta)}` : '';
                return (
                  <div key={i} style={{ color }}>
                    {`[${fmt(l.t)}] ${l.msg}${meta}`}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function safeMeta(m: any) {
  try {
    if (m instanceof Event) return `{Event type="${(m as any).type}"}`;
    return JSON.stringify(m);
  } catch {
    return String(m);
  }
}
