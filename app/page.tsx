'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link'; // 👈 added

type ChatItem = { who: 'User' | 'Agent'; text: string };

const VOICES = [
  { id: '1', name: 'Voice 1', src: '/voices/voice1.png' },
  { id: '2', name: 'Voice 2', src: '/voices/voice2.png' },
  { id: '3', name: 'Voice 3', src: '/voices/voice3.png' },
];

const FALLBACK_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">
      <rect width="480" height="360" rx="16" fill="#000"/>
      <rect x="14" y="14" width="452" height="332" rx="12" fill="#10b981" opacity="0.12"/>
    </svg>`
  );

export default function Page() {
  const [voiceId, setVoiceId] = useState('2');
  const [connected, setConnected] = useState(false);
  const [uiState, setUiState] = useState<'Disconnected' | 'Connected' | 'Listening' | 'Speaking'>('Disconnected');

  // CHAT-ONLY display
  const [chat, setChat] = useState<ChatItem[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  const wsBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }, []);

  // audio graph refs
  const audioRef = useRef<AudioContext | null>(null);
  const micNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const encNodeRef = useRef<AudioWorkletNode | null>(null);
  const playerNodeRef = useRef<AudioWorkletNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false);

  // client-side buffer for mic frames (so we don't lose them before WS opens)
  const pendingFramesRef = useRef<ArrayBuffer[]>([]);

  async function ensureAudioGraph() {
    if (audioRef.current) return;
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC({ sampleRate: 48000 });

    await ac.audioWorklet.addModule('/worklets/pcm-processor.js');
    await ac.audioWorklet.addModule('/worklets/pcm-player.js');

    const player = new AudioWorkletNode(ac, 'pcm-player', { numberOfOutputs: 1, outputChannelCount: [1] });
    player.connect(ac.destination);

    audioRef.current = ac;
    playerNodeRef.current = player;
  }

  // resample PCM16@16k → Float32@ctxRate
  function resamplePcm16ToF32(pcm16: Int16Array, inRate: number, outRate: number): Float32Array {
    if (inRate === outRate) {
      const out = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) out[i] = pcm16[i] < 0 ? pcm16[i] / 0x8000 : pcm16[i] / 0x7fff;
      return out;
    }
    const outLen = Math.round((pcm16.length * outRate) / inRate);
    const out = new Float32Array(outLen);
    const ratio = inRate / outRate;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = pcm16[idx] ?? pcm16[pcm16.length - 1] ?? 0;
      const s1 = pcm16[idx + 1] ?? s0;
      const v0 = s0 < 0 ? s0 / 0x8000 : s0 / 0x7fff;
      const v1 = s1 < 0 ? s1 / 0x8000 : s1 / 0x7fff;
      out[i] = v0 + (v1 - v0) * frac;
    }
    return out;
  }

  async function startVoice() {
    if (startedRef.current) return;
    startedRef.current = true;

    await ensureAudioGraph();
    const ac = audioRef.current!;
    if (ac.state === 'suspended') await ac.resume();

    // mic
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (e: any) {
      startedRef.current = false;
      return;
    }

    // mic → encoder (16k/20ms)
    const mic = ac.createMediaStreamSource(stream);
    const enc = new AudioWorkletNode(ac, 'pcm-processor', { numberOfInputs: 1, numberOfOutputs: 0 });

    enc.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const buf = ev.data;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // flush backlog then send this frame
        if (pendingFramesRef.current.length) {
          for (const f of pendingFramesRef.current) try { ws.send(f); } catch {}
          pendingFramesRef.current.length = 0;
        }
        try { ws.send(buf); } catch {}
      } else {
        if (pendingFramesRef.current.length >= 250) pendingFramesRef.current.shift();
        pendingFramesRef.current.push(buf);
      }
    };

    mic.connect(enc);
    micNodeRef.current = mic;
    encNodeRef.current = enc;

    // WS to server
    const url = `${wsBase}/audio-stream`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setConnected(true);
      setUiState('Connected');

      try { ws.send(JSON.stringify({ type: 'start', voiceId })); } catch {}

      if (pendingFramesRef.current.length) {
        for (const f of pendingFramesRef.current) try { ws.send(f); } catch {}
        pendingFramesRef.current.length = 0;
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const pcm16 = new Int16Array(ev.data as ArrayBuffer);
        const outRate = audioRef.current?.sampleRate || 48000;
        const f32 = resamplePcm16ToF32(pcm16, 16000, outRate);
        playerNodeRef.current?.port.postMessage(f32.buffer, [f32.buffer]);
        return;
      }

      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'chat') {
          setChat((p) => [...p, { who: msg.who === 'Agent' ? 'Agent' : 'User', text: String(msg.text || '') }]);
        } else if (msg.type === 'state') {
          setUiState(msg.state);
        }
      } catch {
        // ignore any non-JSON or stray text
      }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      setConnected(false);
      setUiState('Disconnected');
      stopVoice();
    };

    wsRef.current = ws;
  }

  function stopVoice() {
    try { wsRef.current?.send(JSON.stringify({ type: 'stop' })); } catch {}
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;

    if (encNodeRef.current) { try { encNodeRef.current.disconnect(); } catch {} encNodeRef.current = null; }
    if (micNodeRef.current) { try { micNodeRef.current.disconnect(); } catch {} micNodeRef.current = null; }

    pendingFramesRef.current.length = 0;
    startedRef.current = false;
    setConnected(false);
    setUiState('Disconnected');
  }

  const start = () => { startVoice().catch(() => {}); };
  const stop = () => { stopVoice(); };

  return (
    <main className="min-h-screen bg-black text-neutral-100">
      <div className="mx-auto w-full max-w-[1150px] px-4 py-6">
        <div className="relative rounded-[24px] border border-neutral-800/80 bg-[#0b0b0f]/75 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_18px_48px_rgba(0,0,0,0.5)]">
          
          {/* 🔽 swapped status chip for link button */}
          <div className="relative flex items-center justify-end px-7 pt-4">
            <Link
              href="/chat"
              className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400 transition"
            >
              Go to Case Management Chat →
            </Link>
          </div>

          <div className="relative grid grid-cols-1 gap-5 px-7 pb-5 pt-1 md:grid-cols-[1.35fr_0.9fr]">
            {/* LEFT */}
            <section className="flex flex-col items-center">
              <div className="mb-3 flex items-center justify-center gap-3 whitespace-nowrap">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 font-semibold">C</div>
                <div className="text-sm leading-tight md:text-base md:whitespace-nowrap">
                  <span className="font-semibold tracking-wide">CASE CONNECT</span>
                </div>
              </div>

              <div className="w-full max-w-[980px] text-center">
                <h1 className="mb-2 text-[30px] font-extrabold leading-tight text-amber-300 md:text-[36px] md:whitespace-nowrap">
                  Demo our AI intake experience
                </h1>
                <p className="mx-auto mb-4 max-w-none text-[15px] text-neutral-300 md:text-[16px] md:whitespace-nowrap">
                  Speak with our virtual assistant and experience a legal intake done right.
                </p>
                <button
                  onClick={start}
                  className="mx-auto mb-6 inline-flex rounded-full bg-amber-500 px-5 py-2.5 text-[15px] font-semibold text-black shadow hover:bg-amber-400"
                >
                  Speak with AI Assistant
                </button>
              </div>

              {/* Voices */}
              <div className="w-full max-w-[860px]">
                <h3 className="mb-2 text-center text-[16px] font-semibold text-amber-100">Choose a voice to sample</h3>
                <div className="grid grid-cols-3 gap-4">
                  {VOICES.map((v) => (
                    <div key={v.id} className="flex flex-col items-center">
                      <button
                        onClick={() => setVoiceId(v.id)}
                        className={
                          'group relative aspect-[4/3] w-full max-h-[150px] overflow-hidden rounded-2xl border transition ' +
                          (voiceId === v.id
                            ? 'border-amber-400 shadow-[0_0_20px_rgba(255,200,0,0.15)]'
                            : 'border-neutral-800 hover:border-neutral-700')
                        }
                        style={{ backgroundColor: '#000' }}
                        aria-label={v.name}
                      >
                        <img
                          src={v.src}
                          alt={v.name}
                          className="h-full w-full bg-black object-contain"
                          onError={(e) => {
                            const t = e.currentTarget as HTMLImageElement;
                            if (t.src !== FALLBACK_DATA_URI) t.src = FALLBACK_DATA_URI;
                          }}
                        />
                        {voiceId === v.id && (
                          <div className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-amber-400/80" />
                        )}
                      </button>
                      <div className="mt-1 text-xs text-amber-100">{v.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* RIGHT: chat pane */}
            <section className="flex justify-center">
              <div className="flex h-[520px] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-[#121216]/90">
                <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                  <h2 className="text-base font-semibold">Conversation</h2>
                  <span className="text-xs text-neutral-400">
                    {chat.length} {chat.length === 1 ? 'message' : 'messages'}
                  </span>
                </header>
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                  {chat.length === 0 ? (
                    <p className="select-none text-neutral-400">
                      Click <span className="font-semibold text-amber-300">Speak with AI Assistant</span> to start.
                    </p>
                  ) : (
                    chat.map((m, i) => (
                      <div
                        key={i}
                        className={
                          'rounded-lg px-3 py-2 text-sm ' +
                          (m.who === 'Agent'
                            ? 'bg-neutral-800/70 border border-neutral-700'
                            : 'bg-emerald-900/40 border border-emerald-800/70')
                        }
                      >
                        <div className="mb-0.5 text-[11px] uppercase tracking-wide opacity-70">{m.who}</div>
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-400">
                  Live voice via Deepgram. State: {uiState}.
                </footer>
              </div>
            </section>
          </div>

          <div className="relative -mt-1 flex items-center justify-end gap-3 px-7 pb-5">
            <button
              onClick={start}
              className="rounded-xl bg-amber-500 px-5 py-2 font-semibold text-black hover:bg-amber-400"
            >
              Start
            </button>
            <button onClick={stop} className="rounded-xl bg-neutral-800 px-5 py-2 font-semibold hover:bg-neutral-700">
              Stop
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
