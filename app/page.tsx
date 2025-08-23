'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';

/** ---------- small helpers ---------- */
type LogLine = { t: number; who: 'System' | 'You' | 'Agent'; text: string; level?: 'info'|'warn'|'error' };
const now = () => Math.round(performance.now());
const ms = (n: number) => String(n).padStart(6, ' ');

/** SSR-safe WS base */
function getWSBase(): string {
  const env = process.env.NEXT_PUBLIC_BACKEND_ORIGIN;
  if (env) {
    try { return new URL(env).origin.replace(/^http/, 'ws'); } catch {}
  }
  if (typeof window === 'undefined') return 'ws://localhost'; // never used at runtime in the browser; avoids SSR crash
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

/** log utilities */
function useTranscript() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const add = useCallback((who: LogLine['who'], text: string, level: LogLine['level']='info') => {
    setLines((prev) => [...prev, { t: now(), who, text, level }]);
  }, []);
  const clear = useCallback(() => setLines([]), []);
  return { lines, add, clear };
}

/** ---------- page component ---------- */
export default function Page() {
  const base = useMemo(() => getWSBase(), []);
  const wsRef = useRef<WebSocket | null>(null);
  const runningRef = useRef(false);
  const { lines, add, clear } = useTranscript();
  const [voiceId, setVoiceId] = useState<number>(2);   // default to “Voice 2”
  const [wsState, setWsState] = useState<'idle'|'connecting'|'open'|'closed'>('idle');

  const stop = useCallback(() => {
    try { wsRef.current?.close(1000); } catch {}
    wsRef.current = null;
    runningRef.current = false;
    setWsState('closed');
    add('System', 'WS: requested close (1000).');
  }, [add]);

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    clear();
    setWsState('connecting');

    const url = `${base}/web-demo/ws?voiceId=${voiceId}`;
    add('System', `Connecting → ${url}`);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('open');
      add('System', 'WS: open');
    };

    ws.onerror = (e) => {
      add('System', 'WS: error (see console)', 'error');
      // eslint-disable-next-line no-console
      console.error('[web-demo] ws error', e);
    };

    ws.onclose = (e) => {
      setWsState('closed');
      add('System', `WS: close code=${e.code} reason="${e.reason}" clean=${String(e.wasClean)}`);
      runningRef.current = false;
    };

    ws.onmessage = (ev) => {
      // The demo server currently sends simple strings: "demo: handshake ok", "pong", etc.
      const text = typeof ev.data === 'string' ? ev.data : '[binary]';
      add('Agent', text);
    };
  }, [add, base, clear, voiceId]);

  /** UI helpers */
  const disabled = wsState === 'connecting' || wsState === 'open';

  return (
    <main className="page">
      {/* LEFT: brand + CTA + voices */}
      <section className="left">
        <header className="brand">
          <div className="logo">C</div>
          <div className="brand-text">
            <div className="brand-top">CASE</div>
            <div className="brand-bottom">CONNECT</div>
          </div>
        </header>

        <h1 className="headline">Demo our AI intake experience</h1>
        <p className="sub">
          Speak with our virtual assistant and experience a legal intake done right.
        </p>

        <button className="cta" onClick={start} disabled={disabled}>
          {wsState === 'open' ? 'Connected' : 'Speak with AI Assistant'}
        </button>

        <div className="voices-title">Choose a voice to sample</div>
        <div className="voices">
          {[1,2,3].map((id) => (
            <button
              key={id}
              className={`voice-card ${voiceId === id ? 'active' : ''}`}
              onClick={() => setVoiceId(id)}
              aria-pressed={voiceId === id}
            >
              <div className="avatar">{id}</div>
              <div className="voice-name">Voice {id}</div>
            </button>
          ))}
        </div>

        <a className="smoke" href="/ws-smoke">WebSocket smoke page →</a>
      </section>

      {/* RIGHT: conversation */}
      <section className="right">
        <div className="conv-header">
          <div>
            <div className="conv-title">Conversation</div>
            <div className="conv-sub">Live transcript.</div>
          </div>
          <div className="btns">
            <button className="secondary" onClick={stop} disabled={wsState !== 'open' && wsState !== 'connecting'}>
              Stop
            </button>
            <button className="primary" onClick={start} disabled={disabled}>
              Start
            </button>
          </div>
        </div>

        <div className="transcript" role="log" aria-live="polite">
          {lines.length === 0 ? (
            <div className="empty">Click Start to connect and stream messages here.</div>
          ) : (
            lines.map((ln, i) => (
              <div key={i} className={`line ${ln.level ?? 'info'}`}>
                <span className="time">[{ms(ln.t)}]</span>{' '}
                <span className="who">{ln.who}:</span>{' '}
                <span className="text">{ln.text}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <style jsx>{`
        /* layout */
        .page {
          min-height: 100vh;
          background: #0b0b0d;
          color: #fff;
          display: grid;
          grid-template-columns: minmax(340px, 560px) 1fr;
          gap: 32px;
          padding: 36px 40px;
        }
        @media (max-width: 980px) {
          .page { grid-template-columns: 1fr; }
          .right { order: 2; }
        }

        /* left */
        .left { display: flex; flex-direction: column; gap: 20px; }
        .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
        .logo {
          width: 42px; height: 42px; border-radius: 50%;
          border: 2px solid #23d3c4; color: #23d3c4;
          display: grid; place-items: center; font-weight: 800; font-size: 20px;
        }
        .brand-text { line-height: 1; font-weight: 800; letter-spacing: 0.02em; }
        .brand-top { color: #c4fff7; }
        .brand-bottom { color: #23d3c4; margin-top: 2px; }

        .headline {
          font-size: 36px; font-weight: 800; letter-spacing: -0.02em;
        }
        .sub { color: #b9b9c0; max-width: 40ch; }

        .cta {
          align-self: flex-start;
          background: #ffb31a; color: #121214; font-weight: 700;
          border: none; border-radius: 999px; padding: 12px 18px; cursor: pointer;
        }
        .cta:disabled { opacity: 0.7; cursor: default; }

        .voices-title { color: #cfcfd6; margin-top: 4px; }
        .voices { display: flex; gap: 14px; }
        .voice-card {
          width: 132px; background: #15151a; border: 1px solid #262631; border-radius: 14px;
          padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 10px;
          cursor: pointer; transition: transform 120ms ease, border-color 120ms ease;
        }
        .voice-card:hover { transform: translateY(-1px); border-color: #3a3a49; }
        .voice-card.active { border-color: #23d3c4; }
        .avatar {
          width: 92px; height: 92px; border-radius: 12px; background: #0f0f14;
          display: grid; place-items: center; font-weight: 800; color: #23d3c4; border: 1px solid #2a2a36;
        }
        .voice-name { color: #c7c7d1; font-size: 13px; }

        .smoke { color: #7bd7cd; text-decoration: none; margin-top: 8px; font-size: 14px; }

        /* right */
        .right {
          background: #101014; border: 1px solid #23232e; border-radius: 16px; padding: 16px;
          display: flex; flex-direction: column; min-height: 560px;
        }
        .conv-header {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px;
        }
        .conv-title { font-weight: 800; }
        .conv-sub { color: #9a9aa3; font-size: 13px; }

        .btns { display: flex; gap: 8px; }
        .primary, .secondary {
          border-radius: 999px; border: 1px solid transparent; padding: 10px 16px; cursor: pointer; font-weight: 700;
        }
        .primary { background: #ffb31a; color: #121214; }
        .primary:disabled { opacity: 0.7; cursor: default; }
        .secondary { background: #171722; color: #e2e2e7; border-color: #2a2a38; }

        .transcript {
          margin-top: 8px; background: #0c0c10; border: 1px solid #23232e; border-radius: 12px;
          flex: 1; overflow: auto; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12.5px; line-height: 1.6;
        }
        .empty { color: #7c7c88; }
        .line { white-space: pre-wrap; }
        .line .time { color: #676779; margin-right: 6px; }
        .line .who { color: #23d3c4; font-weight: 700; margin-right: 6px; }
        .line.error .text { color: #ff6b6b; }
      `}</style>
    </main>
  );
}
