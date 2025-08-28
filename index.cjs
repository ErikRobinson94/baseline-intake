/* index.cjs — Next + Express + WebSocket Deepgram bridge (no hard Twilio require) */

const path = require('path');
const http = require('http');
const express = require('express');
const next = require('next');
const WebSocket = require('ws');
const url = require('url');

// ---------- env ----------
const DEV = process.env.NODE_ENV !== 'production';
const PORT = Number(process.env.PORT || 10000);
const DG_URL = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const DG_KEY = process.env.DEEPGRAM_API_KEY || process.env.DG_API_KEY || '';
const STT_MODEL = (process.env.DG_STT_MODEL || 'nova-2').trim();
const DEFAULT_TTS = (process.env.DG_TTS_VOICE || 'aura-2-odysseus-en').trim();
const LLM_MODEL = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
const LLM_TEMP = Number(process.env.LLM_TEMPERATURE || '0.15');

const FIRM = process.env.FIRM_NAME || 'Benji Personal Injury';
const AGENT_NAME = process.env.AGENT_NAME || 'Alexis';
const AGENT_GREETING =
  (process.env.AGENT_GREETING ||
    `Thank you for calling ${FIRM}. Were you in an accident, or are you an existing client?`).trim();

function sanitizeASCII(str) {
  if (!str) return '';
  return String(str).replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactPrompt(s, max = 380) {
  if (!s) return '';
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return 'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
}

const useEnvInstr = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
const RAW_PROMPT = useEnvInstr ? (process.env.AGENT_INSTRUCTIONS || '') : '';
const PROMPT = compactPrompt(sanitizeASCII(RAW_PROMPT ||
  `You are ${AGENT_NAME} for ${FIRM}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say you’ll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say you’ll transfer. Stop if the caller talks.`));

// per-voice overrides
function ttsForVoiceId(voiceId) {
  const n = parseInt(String(voiceId || ''), 10);
  const envKey = `VOICE_${isNaN(n) ? '' : n}_TTS`;
  return (process.env[envKey] || DEFAULT_TTS).trim();
}

// ---------- logger ----------
function jlog(level, evt, obj) {
  const rec = { ts: new Date().toISOString(), level, evt, ...(obj || {}) };
  console.log(JSON.stringify(rec));
}

// ---------- Next + Express ----------
const app = next({ dev: DEV, conf: { distDir: '.next' } });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = express();

  // healthz
  server.get('/healthz', (_req, res) => {
    res.set('content-type', 'application/json');
    res.status(200).send(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  });

  // static from /public (Next handles it), plus fallback to Next
  server.all('*', (req, res) => handle(req, res));

  const httpServer = http.createServer(server);

  // ---------- WS hub ----------
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    jlog('info', 'WS.upgrade', { path: pathname, ua: req.headers['user-agent'] });

    if (pathname === '/ws-echo' || pathname === '/ws-ping' || pathname === '/audio-stream' || pathname === '/web-demo/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (pathname === '/ws-echo') handleEcho(ws);
        else if (pathname === '/ws-ping') handlePing(ws);
        else if (pathname === '/web-demo/ws') handleWebDemoWS(ws);
        else handleAudioStream(ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // ---------- ws-echo ----------
  function handleEcho(ws) {
    ws.on('message', (msg) => {
      try { ws.send(msg); } catch {}
    });
    ws.on('error', () => {});
  }

  // ---------- ws-ping ----------
  function handlePing(ws) {
    try { ws.send('pong'); } catch {}
    ws.on('error', () => {});
  }

  // ---------- web-demo/ws (smoke expects a string) ----------
  function handleWebDemoWS(ws) {
    try { ws.send('demo: hello'); } catch {}
    ws.on('error', () => {});
  }

  // ---------- /audio-stream: Browser 16k PCM16 ↔ Deepgram Agent ----------
  function handleAudioStream(clientWS, req) {
    jlog('info', 'WS.audio.open', { ip: req.socket.remoteAddress });

    if (!DG_KEY) {
      try { clientWS.send(JSON.stringify({ type: 'error', error: { message: 'Missing DEEPGRAM_API_KEY' } })); } catch {}
      try { clientWS.close(1011, 'Missing DEEPGRAM_API_KEY'); } catch {}
      jlog('error', 'DG.missing_api_key');
      return;
    }

    let closed = false;
    let agentWS = null;
    let settingsSent = false;
    let settingsApplied = false;
    let agentOpen = false;
    let startReceived = false;
    let chosenVoice = DEFAULT_TTS;
    let preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s (20ms * 200)

    // deepgram connect
    try {
      agentWS = new WebSocket(DG_URL, ['token', DG_KEY]);
    } catch (e) {
      jlog('error', 'SERVER→DG.open_error', { err: e?.message || String(e) });
      try { clientWS.close(1011, 'DG open failed'); } catch {}
      return;
    }

    const sendState = (state) => { try { clientWS.send(JSON.stringify({ type: 'state', state })); } catch {} };

    agentWS.on('open', () => {
      agentOpen = true;
      jlog('info', 'SERVER→DG.open', { url: DG_URL, ip: req.socket.remoteAddress });
      // only send settings when we also know the voice (after start)
      if (startReceived && !settingsSent) sendSettings();
    });

    // keepalives
    const keep = setInterval(() => {
      if (agentWS && agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    function sendSettings() {
      if (!agentOpen || settingsSent) return;
      const greeting = sanitizeASCII(AGENT_GREETING);
      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'linear16', sample_rate: 16000 },
          output: { encoding: 'linear16', sample_rate: 16000 }
        },
        agent: {
          language: 'en',
          greeting,
          listen: { provider: { type: 'deepgram', model: STT_MODEL, smart_format: true } },
          think:  { provider: { type: 'open_ai', model: LLM_MODEL, temperature: LLM_TEMP }, prompt: PROMPT },
          speak:  { provider: { type: 'deepgram', model: chosenVoice } }
        }
      };
      try {
        agentWS.send(JSON.stringify(settings));
        settingsSent = true;
        jlog('info', 'SERVER→DG.settings_sent', {
          sttModel: STT_MODEL, ttsVoice: chosenVoice, llmModel: LLM_MODEL, temperature: LLM_TEMP
        });
      } catch (e) {
        jlog('error', 'SERVER→DG.settings_send_error', { err: e?.message || String(e) });
      }
    }

    // Agent messages
    agentWS.on('message', (data) => {
      // JSON or binary 16k PCM
      if (Buffer.isBuffer(data)) {
        // TTS audio → client binary
        try { clientWS.send(data, { binary: true }); } catch {}
        return;
      }

      let evt = null; try { evt = JSON.parse(data.toString('utf8')); } catch {}
      if (!evt) return;

      switch (evt.type) {
        case 'Welcome':
          // might happen before we send settings
          break;

        case 'SettingsApplied':
          settingsApplied = true;
          // flush preroll if any
          if (preFrames.length) {
            try { for (const fr of preFrames) agentWS.send(fr); } catch {}
            preFrames = [];
          }
          sendState('Connected'); // keep “Connected” visible until speech
          break;

        // transcripts (try to cover a wide set)
        case 'ConversationText':
        case 'History':
        case 'UserTranscript':
        case 'UserResponse':
        case 'Transcript':
        case 'AddUserMessage':
        case 'AddAssistantMessage':
        case 'PartialTranscript':
        case 'AddPartialTranscript': {
          const text = String(
            evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? ''
          ).trim();
          if (!text) break;

          const role = String(evt.role || evt.speaker || evt.actor || '').toLowerCase();
          const isAgent = role.includes('assistant') || role.includes('agent');
          // simple UI hint
          sendState(isAgent ? 'Speaking' : 'Listening');

          try {
            clientWS.send(JSON.stringify({
              type: 'transcript',
              role: isAgent ? 'Agent' : 'User',
              text,
              partial: evt.final === false || evt.is_final === false || evt.type?.includes('Partial')
            }));
          } catch {}
          break;
        }

        case 'AgentWarning':
          try { clientWS.send(JSON.stringify({ type: 'error', error: { message: evt.message || 'warning' } })); } catch {}
          jlog('warn', 'DG.warning', evt);
          break;

        case 'AgentError':
        case 'Error':
          try { clientWS.send(JSON.stringify({ type: 'error', error: { message: evt.description || evt.message || 'error' } })); } catch {}
          jlog('error', 'DG.error', evt);
          break;

        default:
          // ignore other control events
          break;
      }
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keep);
      jlog('info', 'DG→SERVER.close', { code, reason: Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '') });
      safeClose(1000, '');
    });
    agentWS.on('error', (e) => {
      jlog('warn', 'DG.error', { err: e?.message || String(e) });
    });

    // Browser messages
    clientWS.on('message', (msg) => {
      // first JSON “start” selects voice
      if (typeof msg === 'string') {
        try {
          const js = JSON.parse(msg);
          if (js?.type === 'start') {
            startReceived = true;
            chosenVoice = ttsForVoiceId(js.voiceId);
            sendSettings(); // if agent is ready, push settings now
            return;
          }
          if (js?.type === 'stop') {
            safeClose(1000, 'client stop');
            return;
          }
        } catch { /* ignore */ }
        return;
      }

      // binary mic frames (PCM16 @16k)
      if (agentWS && agentWS.readyState === WebSocket.OPEN) {
        if (!settingsSent || !settingsApplied) {
          preFrames.push(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
          if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
        } else {
          try { agentWS.send(msg); } catch {}
        }
      }
    });

    clientWS.on('close', (code, reason) => {
      jlog('info', 'CLIENT→SERVER.close', { code, reason });
      safeClose(code, reason);
    });
    clientWS.on('error', (e) => {
      jlog('warn', 'CLIENT.error', { err: e?.message || String(e) });
      safeClose(1011, 'client error');
    });

    function safeClose(code, reason) {
      if (closed) return; closed = true;
      try { clearInterval(keep); } catch {}
      try { agentWS && agentWS.close(1000); } catch {}
      try { clientWS && clientWS.close(code || 1000, reason || ''); } catch {}
    }
  }

  httpServer.listen(PORT, () => {
    jlog('info', 'server_listen', { port: PORT, dev: DEV });
  });

  // global failsafe
  process.on('uncaughtException', (e) => jlog('error', 'process_uncaught_exception', { err: e?.message || String(e), stack: e?.stack }));
  process.on('unhandledRejection', (e) => jlog('error', 'process_unhandled_rejection', { err: e?.message || String(e) }));
}).catch((e) => {
  jlog('error', 'server_boot_error', { err: e?.message || String(e), stack: e?.stack });
  process.exit(1);
});
