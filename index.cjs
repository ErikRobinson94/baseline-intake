/* index.cjs – Next + Express + WS + Deepgram bridge */
process.env.TZ = 'UTC';
const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const { WebSocketServer } = require('ws');
const next = require('next');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV = process.env.NODE_ENV !== 'production';

const app = next({ dev: DEV, dir: process.cwd() });
const handle = app.getRequestHandler();

/* ---------- small JSON logger ---------- */
const LV = { error:0, warn:1, info:2, debug:3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = (level, evt, meta) => {
  if ((LV[level] ?? 2) <= (LV[LOG_LEVEL] ?? 2)) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      evt,
      ...(meta || {})
    });
    console.log(line);
  }
};

/* ---------- Deepgram voice bridge (provider-agnostic shell) ---------- */
const WebSocket = require('ws');

function createVoiceBridge({ serverWS, req }) {
  const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
  const apiKey = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    serverWS.close(1011, 'missing DG_API_KEY');
    return;
  }

  let closed = false;
  let readyForAudio = false;

  // Connect to Deepgram Converse
  const dgWS = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${apiKey}` },
    perMessageDeflate: false
  });

  const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
  const ttsVoice = (process.env.DG_TTS_VOICE || 'aura-asteria-en').trim();

  const sendSettings = () => {
    const settings = {
      type: 'Settings',
      audio: {
        input:  { encoding: 'linear16', sample_rate: 16000 },
        output: { encoding: 'linear16', sample_rate: 16000, container: 'none' }
      },
      agent: {
        language: 'en',
        listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
        think:  { provider: { type: 'open_ai', model: 'gpt-4o-mini', temperature: 0.15 } },
        speak:  { provider: { type: 'deepgram', model: ttsVoice } }
      }
    };
    try { dgWS.send(JSON.stringify(settings)); }
    catch (e) { log('error', 'SERVER→DG.settings_error', { err: e.message }); }
  };

  dgWS.on('open', () => {
    log('info', 'SERVER→DG.open', { url: dgUrl, ip: req.socket.remoteAddress });
    sendSettings();
  });

  dgWS.on('message', (data) => {
    // If text event, parse for settings/transcripts; if binary, it's TTS audio (PCM16)
    if (typeof data === 'string') {
      let evt;
      try { evt = JSON.parse(data); } catch {}
      if (evt) {
        if (evt.type === 'Welcome') {
          log('info', 'DG→SERVER.welcome', {});
        } else if (evt.type === 'SettingsApplied') {
          readyForAudio = true;
          log('info', 'DG→SERVER.settings_applied', {});
          try { serverWS.send(JSON.stringify({ type: 'state', state: 'Listening' })); } catch {}
        } else if (
          evt.type === 'Transcript' ||
          evt.type === 'UserTranscript' ||
          evt.type === 'ConversationText'
        ) {
          // pass through lightweight transcript events to client UI (optional)
          try {
            serverWS.send(JSON.stringify({ type: 'transcript', payload: evt }));
          } catch {}
        } else if (evt.type === 'UserStartedSpeaking') {
          try { serverWS.send(JSON.stringify({ type: 'state', state: 'Listening' })); } catch {}
        } else if (evt.type === 'AgentStartedSpeaking') {
          try { serverWS.send(JSON.stringify({ type: 'state', state: 'Speaking' })); } catch {}
        } else if (evt.type === 'Error' || evt.type === 'AgentError') {
          log('warn', 'DG→SERVER.error', { evt });
          try { serverWS.send(JSON.stringify({ type: 'error', error: evt })); } catch {}
        } else {
          log('debug', 'DG→SERVER.other', { evt: evt.type });
        }
      }
      return;
    }

    // Binary → agent TTS audio (PCM16 @16k mono)
    // We forward verbatim to client. Client converts PCM16 → Float32 for playback.
    try {
      serverWS.send(data, { binary: true });
      log('debug', 'DG→SERVER.audio', { bytes: data.length });
    } catch (e) {
      log('warn', 'SERVER→CLIENT.audio_send_err', { err: e.message });
    }
  });

  dgWS.on('close', (code, reason) => {
    log('info', 'DG→SERVER.close', { code, reason: reason?.toString?.() || '' });
    safeClose();
  });

  dgWS.on('error', (e) => {
    log('warn', 'DG→SERVER.ws_error', { err: e?.message || String(e) });
    try { serverWS.send(JSON.stringify({ type: 'error', error: { message: e.message } })); } catch {}
  });

  // Client → Server WS handlers
  serverWS.on('message', (data, isBinary) => {
    // JSON control or raw PCM16 frames
    if (!isBinary && typeof data === 'string') {
      // simple control: {type:"start"} | {type:"stop"} etc. (not strictly needed)
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'start') {
          log('info', 'CLIENT→SERVER.start', {});
          if (dgWS.readyState === WebSocket.OPEN && !readyForAudio) sendSettings();
        }
        if (msg.type === 'stop') {
          log('info', 'CLIENT→SERVER.stop', {});
          safeClose();
        }
      } catch {
        // ignore
      }
      return;
    }

    // Binary mic audio (PCM16 16k mono 20ms)
    if (dgWS.readyState === WebSocket.OPEN && readyForAudio) {
      try {
        dgWS.send(data, { binary: true });
      } catch (e) {
        log('warn', 'SERVER→DG.audio_send_err', { err: e.message });
      }
    }
  });

  serverWS.on('close', () => {
    log('info', 'CLIENT→SERVER.close', {});
    safeClose();
  });

  serverWS.on('error', (e) => {
    log('warn', 'CLIENT→SERVER.ws_error', { err: e?.message || String(e) });
    safeClose();
  });

  function safeClose() {
    if (closed) return;
    closed = true;
    try { dgWS.close(1000); } catch {}
    try { serverWS.close(1000); } catch {}
  }
}

/* ---------- boot ---------- */
async function boot() {
  await app.prepare();
  const srv = express();
  srv.use(morgan('tiny'));

  // simple health check
  srv.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Next handler
  srv.all('*', (req, res) => handle(req, res));

  const server = http.createServer(srv);

  // --- WS: echo
  const wssEcho = new WebSocketServer({ server, path: '/ws-echo', perMessageDeflate: false });
  wssEcho.on('connection', (ws, req) => {
    log('info', 'WS.echo.open', { ip: req.socket.remoteAddress });
    ws.on('message', (data) => {
      log('debug', 'CLIENT→SERVER.echo', { len: data?.length ?? 0 });
      try { ws.send(typeof data === 'string' ? `[echo] ${data}` : data); } catch {}
    });
  });

  // --- WS: ping
  const wssPing = new WebSocketServer({ server, path: '/ws-ping', perMessageDeflate: false });
  wssPing.on('connection', (ws) => {
    const iv = setInterval(() => { try { ws.send('pong'); } catch {} }, 1000);
    ws.on('close', () => clearInterval(iv));
  });

  // --- WS: demo (text only)
  const wssDemo = new WebSocketServer({ server, path: '/web-demo/ws', perMessageDeflate: false });
  wssDemo.on('connection', (ws) => {
    try { ws.send(JSON.stringify({ hello: 'world' })); } catch {}
  });

  // --- WS: audio-stream (voice)
  const wssAudio = new WebSocketServer({ server, path: '/audio-stream', perMessageDeflate: false });
  wssAudio.on('connection', (ws, req) => {
    log('info', 'WS.audio.open', { ip: req.socket.remoteAddress });
    try { ws.send(JSON.stringify({ type: 'state', state: 'Connected' })); } catch {}
    createVoiceBridge({ serverWS: ws, req });
  });

  server.listen(PORT, () => {
    log('info', 'server_listen', { port: PORT, dev: DEV });
  });
}

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
