'use client';

import React, { useMemo, useRef, useState } from 'react';

function getWSBase(): string {
  if (typeof window === 'undefined') return ''; // SSR no-op
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

type Line = { t: number; text: string; kind: 'sys' | 'user' | 'agent' };

export default function Landing() {
  const [voiceId, setVoiceId] = useState<number>(2);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const base = useMemo(() => (typeof window !== 'undefined' ? getWSBase() : ''), []);

  const addLine = (text: string, kind: Line['kind'] = 'sys') =>
    setLines((l) => [...l, { t: Date.now(), text, kind }]);

  function start() {
    if (running || !base) return;
    setRunning(true);
    addLine(`Connecting → ${base}/web-demo/ws?voiceId=${voiceId}`, 'sys');

    const ws = new WebSocket(`${base}/web-demo/ws?voiceId=${voiceId}`);
    wsRef.current = ws;

    ws.onopen = () => addLine('WS: open', 'sys');
    ws.onerror = (e) => addLine(`WS: error (${(e as any).message ?? 'event'})`, 'sys');
    ws.onclose = (e) => {
      addLine(`WS: close code=${e.code} reason="${e.reason}" clean=${e.wasClean}`, 'sys');
      setRunning(false);
      wsRef.current = null;
    };
    ws.onmessage = (ev) => {
      // Baseline server sends strings like "demo: handshake ok" and "pong"
      try {
        if (typeof ev.data === 'string') addLine(ev.data, 'agent');
        else addLine(`(binary ${typeof ev.data})`, 'agent');
      } catch (err) {
        addLine(`msg err: ${String(err)}`, 'sys');
      }
    };
  }

  function stop() {
    try { wsRef.current?.close(); } finally { setRunning(false); }
  }

  return (
    <main style={{minHeight:'100vh', background:'#0b0b0b', color:'#fff', padding:'24px'}}>
      <div style={{maxWidth:1080, margin:'0 auto'}}>
        <header style={{marginBottom:24}}>
          <h1 style={{fontSize:32, fontWeight:800}}>WebSocket smoke test</h1>
          <p style={{color:'#aaa'}}>Click Start to run echo / ping / demo checks against your backend.</p>
        </header>

        {/* Controls */}
        <div style={{display:'flex', gap:12, marginBottom:20}}>
          <button
            disabled={running}
            onClick={start}
            style={{background:'#ffd24d', color:'#000', borderRadius:10, padding:'10px 16px', fontWeight:700}}
          >
            Start (run smoke test)
          </button>
          <button
            disabled={!running}
            onClick={stop}
            style={{background:'#242424', color:'#fff', borderRadius:10, padding:'10px 16px'}}
          >
            Stop
          </button>
          <a href="/ws-smoke" style={{marginLeft:'auto', color:'#9edcff', textDecoration:'underline'}}>Open full WS smoke</a>
        </div>

        {/* Voice picker (simple 3-card row) */}
        <section style={{display:'flex', gap:16, marginBottom:16}}>
          {[1,2,3].map((id) => (
            <button
              key={id}
              onClick={() => setVoiceId(id)}
              style={{
                flex:'0 0 160px',
                height:120,
                borderRadius:14,
                border: id === voiceId ? '2px solid #ffd24d' : '1px solid #333',
                background:'#111',
                color:'#fff',
                cursor:'pointer'
              }}
              aria-pressed={id === voiceId}
            >
              <div style={{fontSize:18, fontWeight:700, marginTop:42, textAlign:'center'}}>Voice {id}</div>
            </button>
          ))}
        </section>

        {/* Transcript */}
        <section style={{border:'1px solid #222', borderRadius:14, background:'#0f0f0f'}}>
          <div style={{padding:16, fontWeight:700, color:'#bbb'}}>Conversation</div>
          <div style={{padding:'8px 16px 16px', height:380, overflow:'auto', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>
            {lines.length === 0 ? (
              <div style={{color:'#555'}}>No messages yet…</div>
            ) : lines.map((l, i) => (
              <div key={i} style={{color: l.kind==='agent' ? '#9ee1a7' : l.kind==='user' ? '#9edcff' : '#dcdcdc'}}>
                [{new Date(l.t).toLocaleTimeString()}] {l.text}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
