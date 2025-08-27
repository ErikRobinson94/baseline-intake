/* index.cjs – Next + Express + WS (manual upgrade routing) + Deepgram Agent bridge */
process.env.TZ = 'UTC';

const http = require('http');
const express = require('express');
const morgan = require('morgan');
const next = require('next');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEV = process.env.NODE_ENV !== 'production';

const app = next({ dev: DEV, dir: process.cwd() });
const handle = app.getRequestHandler();

/* ---------- tiny JSON logger ---------- */
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
function log(level, evt, meta) {
  if ((LV[level] ?? 2) <= (LV[LOG_LEVEL] ?? 2)) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...(meta || {}) }));
  }
}

/* ---------- Deepgram Agent bridge (client WS ⇄ Deepgram Agent WS) ---------- */
function createVoiceBridge({ serverWS, req }) {
  const apiKey = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    log('error', 'DG.missing_api_key', {});
    try { serverWS.send(JSON.stringify({ type: 'error', error: { message: 'Deepgram API key missing on server' } })); } catch {}
    try { serverWS.close(1011, 'missing DG_API_KEY'); } catch {}
    return;
  }

  const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
  const ttsVoice = (process.env.DG_TTS_VOICE || 'aura-asteria-en').trim();
  const llmModel = (process.env.LLM_MODEL   || 'gpt-4o-mini').trim();

  const firm     = process.env.FIRM_NAME     || 'Your Firm';
  const agent    = process.env.AGENT_NAME    || 'Your Specialist';
  const greeting = process.env.AGENT_GREETING
    || `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`;

  const dgUrl = (process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse').trim();

  let closed = false;
  let settingsSent = false;
  let settingsApplied = false;
  const preFrames = [];
  const MAX_PRE_FRAMES = 200; // ~4s at 20ms

  // *** IMPORTANT: use subprotocol "token" with key (matches your old, working code)
  const dgWS = new WebSocket(dgUrl, ['token', apiKey], { perMessageDeflate: false });

  dgWS.on('unexpectedResponse', (_req, res) => {
    log('error', 'DG.unexpected_response', { statusCode: res.statusCode, headers: res.headers });
  });

  function sendSettings() {
    if (settingsSent) return;
    const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');
    const settings = {
      type: 'Settings',
      audio: {
        input:  { encoding: 'linear16', sample_rate: 16000 },
        output: { encoding: 'linear16', sample_rate: 16000 }, // container omitted: defaults OK for Agent
      },
      agent: {
        language: 'en',
        greeting,
        listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
        think:  { provider: { type: 'open_ai', model: llmModel, temperature } },
        speak:  { provider: { type: 'deepgram', model: ttsVoice } },
      },
    };
    try {
      dgWS.send(JSON.stringify(settings));
      settingsSent = true;
      log('info', 'SERVER→DG.settings_sent', { sttModel, ttsVoice, llmModel, temperature });
      try { serverWS.send(JSON.stringify({ type: 'state', state: 'Connected' })); } catch {}
    } catch (e) {
      log('error', 'SERVER→DG.settings_error', { err: e.message });
      try { serverWS.send(JSON.stringify({ type: 'error', error: { message: 'Failed to send Settings to Deepgram' } })); } catch {}
    }
  }

  dgWS.on('open', () => {
    log('info', 'SERVER→DG.open', { url: dgUrl, ip: req.socket.remoteAddress });
    sendSettings();
  });

  // KeepAlive to Agent
  const keepalive = setInterval(() => {
    if (dgWS.readyState === WebSocket.OPEN) {
      try { dgWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }
  }, 25000);

  dgWS.on('message', (data) => {
    if (typeof data === 'string') {
      let evt; try { evt = JSON.parse(data); } catch {}
      if (evt) {
        switch (evt.type) {
          case 'Welcome':
            log('info', 'DG→SERVER.welcome'); sendSettings(); break;
          case 'SettingsApplied':
            settingsApplied = true;
            log('info', 'DG→SERVER.settings_applied');
            try { serverWS.send(JSON.stringify({ type: 'state', state: 'Listening' })); } catch {}
            // Flush preroll
            if (preFrames.length) {
              try { for (const fr of preFrames) dgWS.send(fr); } catch {}
              preFrames.length = 0;
            }
            break;
          case 'UserStartedSpeaking':
            try { serverWS.send(JSON.stringify({ type: 'state', state: 'Listening' })); } catch {}
            break;
          case 'AgentStartedSpeaking':
            try { serverWS.send(JSON.stringify({ type: 'state', state: 'Speaking' })); } catch {}
            break;
          case 'AgentStoppedSpeaking':
            try { serverWS.send(JSON.stringify({ type: 'state', state: 'Listening' })); } catch {}
            break;
          case 'Transcript':
          case 'UserTranscript':
          case 'ConversationText':
          case 'History':
          case 'UserResponse':
            try { serverWS.send(JSON.stringify({ type: 'transcript', payload: evt })); } catch {}
            break;
          case 'Error':
          case 'AgentError':
            log('warn', 'DG→SERVER.error', { evt });
            try { serverWS.send(JSON.stringify({ type: 'error', error: evt })); } catch {}
            break;
          default:
            log('debug', 'DG→SERVER.other', { type: evt.type });
        }
      }
      return;
    }

    // Binary TTS audio → client
    try {
      serverWS.send(data, { binary: true });
      log('debug', 'DG→SERVER.audio', { bytes: data.length });
    } catch (e) {
      log('warn', 'SERVER→CLIENT.audio_send_err', { err: e.message });
    }
  });

  dgWS.on('close', (code, reason) => {
    log('info', 'DG→SERVER.close', { code, reason: reason?.toString?.() || '' });
    clearInterval(keepalive);
    safeClose();
  });

  dgWS.on('error', (e) => {
    log('warn', 'DG→SERVER.ws_error', { err: e?.message || String(e) });
    try { serverWS.send(JSON.stringify({ type: 'error', error: { message: e.message } })); } catch {}
  });

  // Client → Server WS (16k PCM16 audio frames or JSON)
  serverWS.on('message', (data, isBinary) => {
    if (!isBinary && typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'start') {
          log('info', 'CLIENT→SERVER.start', {});
          if (dgWS.readyState === WebSocket.OPEN && !settingsSent) sendSettings();
        } else if (msg.type === 'stop') {
          log('info', 'CLIENT→SERVER.stop', {});
          safeClose();
        }
      } catch { /* ignore non-JSON */ }
      return;
    }
    // Binary mic audio
    if (dgWS.readyState !== WebSocket.OPEN) return;
    if (!settingsApplied) {
      preFrames.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
      return;
    }
    try { dgWS.send(data, { binary: true }); }
    catch (e) { log('warn', 'SERVER→DG.audio_send_err', { err: e.message }); }
  });

  serverWS.on('close', (code, reason) => { log('info', 'CLIENT→SERVER.close', { code, reason }); safeClose(); });
  serverWS.on('error', (e) => { log('warn', 'CLIENT→SERVER.ws_error', { err: e?.message || String(e) }); safeClose(); });

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
  srv.set('trust proxy', 1);
  srv.use(morgan('tiny'));

  // Health + hint for plain HTTP on WS path
  srv.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  srv.get('/audio-stream', (_req, res) => res.status(426).send('Use WebSocket (wss) to /audio-stream'));

  const server = http.createServer(srv);

  // WS servers (noServer; routed manually on 'upgrade')
  const wssEcho  = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wssPing  = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wssDemo  = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wssAudio = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // /ws-echo
  wssEcho.on('connection', (ws, req) => {
    log('info', 'WS.echo.open', { ip: req.socket.remoteAddress });
    ws.on('message', (data) => {
      log('debug', 'CLIENT→SERVER.echo', { len: data?.length ?? 0 });
      try { ws.send(typeof data === 'string' ? `[echo] ${data}` : data); } catch {}
    });
  });

  // /ws-ping
  wssPing.on('connection', (ws) => {
    const iv = setInterval(() => { try { ws.send('pong'); } catch {} }, 1000);
    ws.on('close', () => clearInterval(iv));
  });

  // /web-demo/ws (simple hello)
  wssDemo.on('connection', (ws) => {
    try { ws.send(JSON.stringify({ hello: 'world' })); } catch {}
  });

  // /audio-stream (Deepgram bridge)
  wssAudio.on('connection', (ws, req) => {
    log('info', 'WS.audio.open', { ip: req.socket.remoteAddress });
    try { ws.send(JSON.stringify({ type: 'state', state: 'Connected' })); } catch {}
    createVoiceBridge({ serverWS: ws, req });
  });

  // Manual upgrade router
  server.on('upgrade', (req, socket, head) => {
    const hdrUp = String(req.headers['upgrade'] || '').toLowerCase();
    if (hdrUp !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let pathname = '/';
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      pathname = url.pathname;
    } catch {}

    log('info', 'WS.upgrade', { path: pathname, ua: req.headers['user-agent'] });

    if (pathname === '/ws-echo') {
      wssEcho.handleUpgrade(req, socket, head, (ws) => wssEcho.emit('connection', ws, req));
    } else if (pathname === '/ws-ping') {
      wssPing.handleUpgrade(req, socket, head, (ws) => wssPing.emit('connection', ws, req));
    } else if (pathname === '/web-demo/ws') {
      wssDemo.handleUpgrade(req, socket, head, (ws) => wssDemo.emit('connection', ws, req));
    } else if (pathname === '/audio-stream') {
      wssAudio.handleUpgrade(req, socket, head, (ws) => wssAudio.emit('connection', ws, req));
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  // Next.js handler
  srv.use((req, res) => handle(req, res));

  server.listen(PORT, () => {
    log('info', 'server_listen', { port: PORT, dev: DEV });
  });
}

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
