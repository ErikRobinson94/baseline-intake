// lib/web-demo-live.cjs
const WebSocket = require('ws');
const { makeShadowIntake, updateIntakeFromUserText, intakeSnapshot } =
  require('./shadow-intake.cjs');

/* logging (same levels as index.cjs) */
const LVL = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const THRESH = LVL[LOG_LEVEL] ?? LVL.info;
function jlog(level, evt, meta = {}) {
  const lvlNum = LVL[level] ?? LVL.info;
  if (lvlNum < THRESH) return;
  const rec = { ts: new Date().toISOString(), level, evt, ...meta };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`[${level}] ${evt}`, meta); }
}

const say = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

function sanitizeASCII(str) {
  if (!str) return '';
  return String(str).replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
}
function compact(s, max = 380) {
  if (!s) return '';
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return 'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
}

/* Try a list of Agent URLs and return full diagnostics for each try */
function connectDeepgram(candidates, protocols) {
  return new Promise((resolve) => {
    const reasons = [];
    let i = 0;

    const next = () => {
      if (i >= candidates.length) return resolve({ ok: false, reasons });
      const url = candidates[i++];
      jlog('info', 'DG.handshake_try', { url });

      const ws = new WebSocket(url, protocols, { handshakeTimeout: 8000 });

      let body = '';
      ws.once('open', () => resolve({ ok: true, url, ws }));

      ws.once('unexpected-response', (_req, res) => {
        const status = res?.statusCode ?? 0;
        const headers = res?.headers || {};
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (typeof chunk === 'string' && body.length < 2048) body += chunk;
        });
        res.on('end', () => {
          const reason = { url, kind: 'unexpected-response', status, headers, body: body.slice(0, 2048) };
          reasons.push(reason);
          jlog('warn', 'DG.handshake_rejected', reason);
          try { ws.terminate(); } catch {}
          next();
        });
      });

      ws.once('error', (e) => {
        const reason = { url, kind: 'error', code: e?.code || null, message: e?.message || String(e) };
        reasons.push(reason);
        jlog('warn', 'DG.handshake_error', reason);
        try { ws.terminate(); } catch {}
        next();
      });

      ws.once('close', (code, reason) => {
        const r = { url, kind: 'closed', code, reason: String(reason || '') };
        reasons.push(r);
        jlog('warn', 'DG.handshake_closed', r);
        next();
      });
    };

    next();
  });
}

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on('connection', async (browserWS, req) => {
    const connId = Math.random().toString(36).slice(2, 9);
    jlog('info', 'CLIENT→SERVER.open', { route, connId, ua: req.headers['user-agent'] });

    let closed = false;

    // voice choice
    let voiceId = 1;
    try {
      const u = new URL(req.url, 'http://local');
      const v = parseInt(u.searchParams.get('voiceId') || '1', 10);
      if ([1, 2, 3].includes(v)) voiceId = v;
    } catch {}
    const ttsVoice =
      process.env[`VOICE_${voiceId}_TTS`] ||
      process.env.DG_TTS_VOICE ||
      'aura-2-odysseus-en';

    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      const msg = 'Missing DEEPGRAM_API_KEY';
      jlog('error', 'DG.missing_api_key', { connId });
      say(browserWS, { type: 'error', error: { message: msg } });
      try { browserWS.close(1008, 'missing_api_key'); } catch {}
      return;
    }
    const protocols = ['token', key];

    const candidates = [
      process.env.DG_AGENT_URL && process.env.DG_AGENT_URL.trim(),
      'wss://agent.deepgram.com/v1/agent/converse',
      'wss://agent.deepgram.com/v1/agent',
    ].filter(Boolean);

    const conn = await connectDeepgram(candidates, protocols);
    if (!conn.ok) {
      jlog('error', 'DG.connect_failed', { connId, reasons: conn.reasons });
      say(browserWS, { type: 'error', error: { message: 'Deepgram connection failed', detail: conn.reasons } });
      try { browserWS.close(1011, 'dg_connect_failed'); } catch {}
      return;
    }

    const agentWS = conn.ws;
    jlog('info', 'SERVER→DG.open', { connId, url: conn.url });

    const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
    const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
    const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');

    const firm      = process.env.FIRM_NAME  || 'Benji Personal Injury';
    const agentName = process.env.AGENT_NAME || 'Alexis';
    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say you’ll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say you’ll transfer. Stop when the caller talks.`;

    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
    const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
    const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
    const prompt = compact(rawPrompt, 380);

    const greeting = sanitizeASCII(
      process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
    );

    const intake = makeShadowIntake();

    let settingsSent = false;
    let settingsApplied = false;

    function sendSettingsOnce() {
      if (settingsSent) return;
      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'linear16', sample_rate: 16000 },
          output: { encoding: 'linear16', sample_rate: 16000 },
        },
        agent: {
          language: 'en',
          greeting,
          listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
          think:  { provider: { type: 'open_ai', model: llmModel, temperature }, prompt },
          speak:  { provider: { type: 'deepgram', model: ttsVoice } },
        },
      };
      try {
        agentWS.send(JSON.stringify(settings));
        settingsSent = true;
        jlog('info', 'SERVER→DG.settings_sent', { connId, sttModel, ttsVoice, llmModel, temperature });
        say(browserWS, { type: 'state', state: 'Connected' });
      } catch (e) {
        jlog('error', 'SERVER→DG.settings_send_failed', { connId, err: e?.message || String(e) });
        say(browserWS, { type: 'error', error: { message: 'Failed to send DG Settings' } });
      }
    }

    agentWS.on('open', () => sendSettingsOnce());

    // keepalive + meters
    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);
    let micBytes = 0, ttsBytes = 0;
    const meter = setInterval(() => {
      if (micBytes || ttsBytes) {
        jlog('debug', 'meter', { connId, mic_bytes_per_s: micBytes, tts_bytes_per_s: ttsBytes });
        micBytes = 0; ttsBytes = 0;
      }
    }, 1000);

    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s

    agentWS.on('message', (data) => {
      const isBuf = Buffer.isBuffer(data);
      if (!isBuf || (isBuf && data.length && data[0] === 0x7b)) {
        let evt = null; try { evt = JSON.parse(isBuf ? data.toString('utf8') : data); } catch {}
        if (!evt) return;

        const role = String((evt.role || evt.speaker || evt.actor || '')).toLowerCase();
        const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
        const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';

        switch (evt.type) {
          case 'Welcome': sendSettingsOnce(); break;
          case 'SettingsApplied':
            settingsApplied = true;
            jlog('info', 'DG.settings_applied', { connId });
            if (preFrames.length) {
              try { for (const fr of preFrames) agentWS.send(fr); } catch {}
              preFrames.length = 0;
            }
            break;

          case 'AgentWarning':
            jlog('warn', 'DG.warning', { connId, message: evt.message || 'unknown' });
            say(browserWS, { type: 'status', text: `Agent warning: ${evt.message || 'unknown'}` });
            break;

          case 'AgentError':
          case 'Error':
            jlog('error', 'DG.error', { connId, message: evt.description || evt.message || 'unknown' });
            say(browserWS, { type: 'error', error: { message: evt.description || evt.message || 'DG error' } });
            break;

          default: {
            if (text) {
              if (role.includes('user')) updateIntakeFromUserText(intake, text);
              say(browserWS, { type: 'transcript', role: role.includes('agent') ? 'Agent' : 'User', text, partial: !isFinal });
            }
          }
        }
        return;
      }

      // Binary TTS → Browser
      ttsBytes += data.length;
      try { browserWS.send(data, { binary: true }); } catch {}
    });

    agentWS.on('error', (e) => {
      jlog('warn', 'DG.error_event', { connId, code: e?.code || null, err: e?.message || String(e) });
      say(browserWS, { type: 'error', error: { message: `Deepgram error: ${e?.message || 'unknown'}` } });
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive); clearInterval(meter);
      jlog('info', 'DG→SERVER.close', { connId, code, reason: String(reason || '') });
      try { jlog('info', 'intake_final', intakeSnapshot(intake)); } catch {}
      say(browserWS, { type: 'status', text: `Upstream closed (code=${code || 0}, reason="${String(reason || '')}")` });
      try { browserWS.close(1011, 'upstream_closed'); } catch {}
    });

    // Browser mic → DG
    const FRAME_MS = 20, IN_RATE = 16000, BYTES_PER_SAMPLE = 2;
    const BYTES_PER_FRAME = Math.round(IN_RATE * BYTES_PER_SAMPLE * (FRAME_MS / 1000)); // 640
    let micBuf = Buffer.alloc(0);

    browserWS.on('message', (msg) => {
      if (typeof msg === 'string') return;          // ignore control JSON
      if (agentWS.readyState !== WebSocket.OPEN) return;

      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      micBytes += buf.length;
      micBuf = Buffer.concat([micBuf, buf]);

      while (micBuf.length >= BYTES_PER_FRAME) {
        const frame = micBuf.subarray(0, BYTES_PER_FRAME);
        micBuf = micBuf.subarray(BYTES_PER_FRAME);
        if (!settingsSent || !settingsApplied) {
          preFrames.push(frame);
          if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
        } else {
          try { agentWS.send(frame); } catch {}
        }
      }
    });

    browserWS.on('close', () => {
      if (closed) return;
      closed = true;
      jlog('info', 'CLIENT→SERVER.close', { connId });
      try { agentWS.close(1000); } catch {}
    });

    browserWS.on('error', (e) => {
      jlog('warn', 'CLIENT→SERVER.error', { connId, err: e?.message || String(e) });
      try { agentWS.close(1011, 'browser_error'); } catch {}
    });
  });

  jlog('info', 'web_demo_live_ready', { route });
}

module.exports = { setupWebDemoLive };
