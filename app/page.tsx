'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

type Log = { t: number; level: 'info' | 'warn' | 'error'; msg: string; meta?: any };
const now = () => Math.round(performance.now());
const fmt = (ms: number) => ms.toString().padStart(6, ' ');

function useLogger() {
  const [logs, setLogs] = useState<Log[]>([]);
  const add = useCallback((level: Log['level'], msg: string, meta?: any) => {
    const entry: Log = { t: now(), level, msg, meta };
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[ui ${level}]`, msg, meta ?? '');
    setLogs(l => [...l, entry]);
  }, []);
  const clear = useCallback(() => setLogs([]), []);
  return { logs, add, clear };
}

function wsBase(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

async function wsTry(
  url: string,
  opts: {
    name: string;
    expect?: (e: MessageEvent) => boolean;
    onOpen?: (ws: WebSocket) => void;
    timeoutMS?: number;
    closeAfter?: number;
    logger: (level: Log['level'], msg: string, meta?: any) => void;
  }
) {
  const { name, onOpen, expect, timeoutMS = 4000, closeAfter = 0, logger } = opts;
  logger('info', `[try] ${name} -> ${url}`);
  const started = now();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(url);
    const finish = (ok: boolean, why?: any) => {
      if (done) return; done = true;
      const dur = now() - started;
      ok ? logger('info', `[ok] ${name} in ${dur}ms`) : logger('error', `[fail] ${name} in ${dur}ms`, why);
      try { ws.close(); } catch {}
      ok ? resolve() : reject(why);
    };
    const to = setTimeout(() => finish(false, new Error(`timeout ${timeoutMS}ms`)), timeoutMS);

    ws.onopen = () => { logger('info', `[open] ${name}`); try { onOpen?.(ws); } catch (e) { clearTimeout(to); finish(false, e); } };
    ws.onerror = (e) => { clearTimeout(to); finish(false, e); };
    ws.onmessage = (e) => {
      logger('info', `[msg] ${name}`, typeof e.data);
      if (!expect) return;
      let ok = false;
      try { ok = expect(e); } catch (er) { clearTimeout(to); finish(false, er); return; }
      if (ok) {
        if (closeAfter > 0) setTimeout(() => { clearTimeout(to); finish(true); }, closeAfter);
        else { clearTimeout(to); finish(true); }
      }
    };
    ws.onclose = (e) => logger('warn', `[close] ${name}`, { code: e.code, reason: e.reason, clean: e.wasClean });
  });
}

export default function Page() {
  const { logs, add, clear } = useLogger();
  const runningRef = useRef(false);
  const base = useMemo(() => wsBase(), []);
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

      await wsTry(urls.demo, {
        name: 'web-demo',
        expect: () => true,
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
    <main style={{ minHeight: '100vh', padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>WebSocket smoke test</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={smoke} style={{ padding: '8px 12px', borderRadius: 8, background: '#ffd34d', border: 0, fontWeight: 600 }}>
          Start (run smoke)
        </button>
        <button onClick={clear} style={{ padding: '8px 12px', borderRadius: 8, background: '#eee', border: 0 }}>
          Clear
        </button>
      </div>
      <pre style={{ background: '#0b0b0b', color: '#9effa1', padding: 16, minHeight: 320, overflow: 'auto' }}>
        {logs.length === 0
          ? 'Logs will appear here…'
          : logs.map((l, i) => {
              const color = l.level === 'error' ? '#ff6b6b' : l.level === 'warn' ? '#ffd34d' : '#9effa1';
              return <div key={i} style={{ color }}>{`[${fmt(l.t)}] ${l.msg}${l.meta ? '  ' + safeMeta(l.meta) : ''}`}</div>;
            })}
      </pre>
    </main>
  );
}

function safeMeta(m: any) {
  try { if (m instanceof Event) return `{Event type="${(m as any).type}"}`; return JSON.stringify(m); }
  catch { return String(m); }
}
