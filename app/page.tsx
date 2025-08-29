'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ChatLine = { id: string; who: 'User' | 'Agent'; text: string };

function rid() {
  // Browser-safe random id (no Node 'crypto' import)
  const c = globalThis.crypto as Crypto | undefined;
  return (c?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10));
}

export default function HomePage() {
  // ---------- UI state ----------
  const [running, setRunning] = useState(false);
  const [voiceId, setVoiceId] = useState<1 | 2 | 3>(2);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // ---------- audio / ws refs ----------
  const wsRef = useRef<WebSocket | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micNodeRef = useRef<AudioWorkletNode | null>(null);
  const playerNodeRef = useRef<AudioWorkletNode | null>(null);

  // timers (typed for browser)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------- helpers ----------
  const wsUrl = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/audio-stream?voiceId=${voiceId}`;
  }, [voiceId]);

  const pushChat = useCallback((who: 'User' | 'Agent', text: string) => {
    if (!text) return;
    setChat((prev) => [...prev, { id: rid(), who, text }]);
  }, []);

  // auto-scroll conversation
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat]);

  // ---------- start / stop ----------
  const stopAll = useCallback(() => {
    setRunning(false);

    // WS
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;

    // audio
    try { micNodeRef.current?.disconnect(); } catch {}
    micNodeRef.current = null;

    try { playerNodeRef.current?.disconnect(); } catch {}
    playerNodeRef.current = null;

    try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    micStreamRef.current = null;

    try { acRef.current?.close(); } catch {}
    acRef.current = null;

    // timers
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const startAll = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setChat([]); // fresh conversation

    // AudioContext + worklets
    const ac = new AudioContext({ sampleRate: 48000 });
    acRef.current = ac;

    // load worklets
    await ac.audioWorklet.addModule('/worklets/pcm-processor.js');
    await ac.audioWorklet.addModule('/worklets/pcm-player.js');

    // mic
    const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    micStreamRef.current = ms;

    const micSource = ac.createMediaStreamSource(ms);
    const micNode = new AudioWorkletNode(ac, 'pcm-processor');   // emits 16k PCM16 20ms frames via port
    const playerNode = new AudioWorkletNode(ac, 'pcm-player');   // accepts PCM16 16k via port

    micNodeRef.current = micNode;
    playerNodeRef.current = playerNode;

    micSource.connect(micNode);
    playerNode.connect(ac.destination);

    // WebSocket
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      // start pings just to keep infra happy
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        try { ws.send(new Uint8Array(0)); } catch {}
      }, 25000);
    });

    // mic -> ws (binary only)
    micNode.port.onmessage = (ev: MessageEvent) => {
      // our worklet posts {type:'frame', data:ArrayBuffer} for each 20ms chunk
      const msg: any = ev.data;
      if (!msg || msg.type !== 'frame') return;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg.data as ArrayBuffer); } catch {}
      }
    };

    // ws -> player + chat
    ws.addEventListener('message', async (ev) => {
      if (typeof ev.data === 'string') {
        let obj: any;
        try { obj = JSON.parse(ev.data); } catch { obj = null; }
        if (!obj) return;

        // we only surface clean chat lines
        if (obj.type === 'chat' && (obj.who === 'User' || obj.who === 'Agent') && typeof obj.text === 'string') {
          pushChat(obj.who, obj.text);
        }
        return;
      }

      // binary = PCM16@16k for playback
      try {
        const ab: ArrayBuffer = (ev.data as ArrayBuffer);
        playerNode.port.postMessage({ type: 'play', data: ab }, [ab]);
      } catch {}
    });

    ws.addEventListener('close', () => stopAll());
    ws.addEventListener('error', () => stopAll());

    // Ensure context is running for autoplay policies
    if (ac.state !== 'running') await ac.resume();
  }, [pushChat, stopAll, wsUrl, running]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopAll();
  }, [stopAll]);

  // ---------- UI ----------
  const VoiceCard: React.FC<{ id: 1 | 2 | 3; label: string; src: string }> = ({ id, label, src }) => {
    const active = voiceId === id;
    return (
      <button
        onClick={() => setVoiceId(id)}
        className={`rounded-2xl p-3 border transition ${
          active ? 'border-yellow-400 ring-2 ring-yellow-400/40' : 'border-zinc-700 hover:border-zinc-500'
        }`}
        aria-pressed={active}
      >
        <img src={src} alt={label} className="w-56 h-40 object-cover rounded-xl" />
        <div className="text-center mt-2 text-sm text-zinc-300">{label}</div>
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-full bg-emerald-500 grid place-items-center font-semibold">C</div>
          <div className="text-zinc-300">CASE CONNECT</div>
        </header>

        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight">
          Demo our <span className="text-yellow-400">AI intake</span> experience
        </h1>
        <p className="text-zinc-300 mt-3">
          Speak with our virtual assistant and experience a legal intake done right.
        </p>

        <div className="mt-6">
          {!running ? (
            <button
              onClick={startAll}
              className="px-6 py-3 rounded-2xl bg-yellow-400 text-black font-semibold hover:brightness-95 transition"
            >
              Speak with AI Assistant
            </button>
          ) : (
            <button
              onClick={stopAll}
              className="px-6 py-3 rounded-2xl bg-rose-500 text-white font-semibold hover:brightness-95 transition"
            >
              End conversation
            </button>
          )}
        </div>

        <section className="mt-8">
          <h2 className="text-lg font-semibold mb-3 text-zinc-200">Choose a voice to sample</h2>
          <div className="flex gap-6 flex-wrap">
            <VoiceCard id={1} label="Voice 1" src="/voices/voice1.png" />
            <VoiceCard id={2} label="Voice 2" src="/voices/voice2.png" />
            <VoiceCard id={3} label="Voice 3" src="/voices/voice3.png" />
          </div>
        </section>

        <section className="mt-10">
          <h3 className="text-lg font-semibold mb-3 text-zinc-200">Conversation</h3>
          <div
            ref={scrollerRef}
            className="h-80 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3"
          >
            {chat.map((m) => (
              <div
                key={m.id}
                className={`px-3 py-2 rounded-xl max-w-[85%] ${
                  m.who === 'User'
                    ? 'bg-sky-600/20 border border-sky-700/50 self-end ml-auto'
                    : 'bg-emerald-600/20 border border-emerald-700/50'
                }`}
              >
                <div className="text-xs uppercase tracking-wide opacity-70 mb-1">{m.who}</div>
                <div className="whitespace-pre-wrap">{m.text}</div>
              </div>
            ))}
            {!chat.length && (
              <div className="text-zinc-500">Press “Speak with AI Assistant” to start.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
