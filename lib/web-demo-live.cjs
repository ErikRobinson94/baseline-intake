// lib/web-demo-live.cjs
const WebSocket = require('ws');
const {
  makeIntakeState,
  updateIntakeFromUserText,
  intakeSnapshot,
} = require('./shadow-intake.cjs');

function jlog(level, evt, meta = {}) {
  const rec = { ts: new Date().toISOString(), level, evt, ...meta };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`[${level}] ${evt}`, meta); }
}

// sanitize/compact helpers (unchanged)
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

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on('connection', (browserWS, req) => {
    let closed = false;
    jlog('info', 'CLIENT→SERVER.open', { route });

    // voiceId
    let voiceId = 1;
    try {
      const u = new URL(req.url, 'http://localhost');
      const v = parseInt(u.searchParams.get('voiceId') || '1', 10);
      if ([1, 2, 3].includes(v)) voiceId = v;
    } catch {}

    const ttsFromEnv =
      process.env[`VOICE_${voiceId}_TTS`] ||
      process.env.DG_TTS_VOICE ||
      'aura-2-odysseus-en';

    // Deepgram Agent
    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      try { browserWS.send(JSON.stringify({ type: 'error', error: { message: 'Missing DEEPGRAM_API_KEY' } })); } catch {}
      jlog('error', 'DG.missing_api_key');
      return;
    }
    const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

    const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
    const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
    const ttsVoice = ttsFromEnv;

    // prompt/greeting
    const firm      = process.env.FIRM_NAME  || 'Benji Personal Injury';
    const agentName = process.env.AGENT_NAME || 'Alexis';
    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
    const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
    const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
    const prompt = compact(rawPrompt, 380);

    const greeting = sanitizeASCII(
      process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
    );

    // shadow intake state
    const intake = makeIntakeState();

    let settingsSent = false;
    let settingsApplied = false;

    function sendSettings() {
      if (settingsSent) return;
      const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');
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
        jlog('info', 'SERVER→DG.settings_sent', { sttModel, ttsVoice, llmModel, temperature });
      } catch (e) {
        try { browserWS.send(JSON.stringify({ type: 'error', error: { message: 'Failed to send Settings to Deepgram.' } })); } catch {}
        jlog('error', 'SERVER→DG.send_settings_error', { err: e?.message || String(e) });
      }
    }

    agentWS.on('open', () => {
      jlog('info', 'SERVER→DG.open', { url: dgUrl, ip: req.socket?.remoteAddress });
      try { browserWS.send(JSON.stringify({ type: 'state', state: 'Connected' })); } catch {}
      sendSettings();
    });

    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    // meters
    let meterMicBytes = 0, meterTtsBytes = 0;
    const meter = setInterval(() => {
      if (meterMicBytes || meterTtsBytes) {
        jlog('info', 'meter', { mic_bytes_per_s: meterMicBytes, tts_bytes_per_s: meterTtsBytes });
        meterMicBytes = 0; meterTtsBytes = 0;
      }
    }, 1000);

    function forwardTranscript(role, text, isFinal) {
      const payload = { type: 'transcript', role: role === 'agent' ? 'Agent' : 'User', text, partial: !isFinal };
      try { browserWS.send(JSON.stringify(payload)); } catch {}
    }

    // preroll
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
          case 'Welcome':
            sendSettings();
            break;
          case 'SettingsApplied':
            settingsApplied = true;
            if (preFrames.length) {
              try { for (const fr of preFrames) agentWS.send(fr); } catch {}
              preFrames.length = 0;
            }
            break;
          // transcript-ish
          case 'ConversationText':
          case 'History':
          case 'UserTranscript':
          case 'UserResponse':
          case 'Transcript':
          case 'AddUserMessage':
          case 'AddAssistantMessage':
          case 'AgentTranscript':
          case 'AgentResponse':
          case 'PartialTranscript':
          case 'AddPartialTranscript':
            if (!text) break;
            if (role.includes('agent') || role.includes('assistant')) {
              forwardTranscript('agent', text, isFinal);
            } else if (role.includes('user')) {
              forwardTranscript('user', text, isFinal);
              // shadow intake update on USER words
              updateIntakeFromUserText(intake, text, (snap) => {
                jlog('info', 'intake_snapshot', snap);
                // If you want the UI to see snapshots, uncomment:
                // try { browserWS.send(JSON.stringify({ type: 'intake', snapshot: snap })); } catch {}
              });
            }
            break;
          case 'AgentWarning':
            try { browserWS.send(JSON.stringify({ type: 'error', error: { message: `Agent warning: ${evt.message || 'unknown'}` } })); } catch {}
            jlog('warn', 'DG→SERVER.warning', { message: evt.message || '' });
            break;
          case 'AgentError':
          case 'Error':
            try { browserWS.send(JSON.stringify({ type: 'error', error: { message: evt.description || evt.message || 'unknown' } })); } catch {}
            jlog('error', 'DG→SERVER.error', { message: evt.description || evt.message || '' });
            break;
        }
        return;
      }

      // Binary = DG TTS PCM16 @ 16k → forward to browser
      meterTtsBytes += data.length;
      try { browserWS.send(data, { binary: true }); } catch {}
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive); clearInterval(meter);
      try { browserWS.send(JSON.stringify({ type: 'state', state: 'Disconnected' })); } catch {}
      jlog('info', 'intake_final', intakeSnapshot(intake));
      jlog('info', 'DG→SERVER.close', { code, reason: reason?.toString?.() || '' });
      safeClose();
    });

    agentWS.on('error', (e) => {
      try { browserWS.send(JSON.stringify({ type: 'error', error: { message: `Deepgram error: ${e?.message || e}` } })); } catch {}
      jlog('warn', 'DG→SERVER.error_evt', { err: e?.message || String(e) });
    });

    // Browser mic → DG, 20ms framing
    const FRAME_MS = 20, IN_RATE = 16000, BPS = 2;
    const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS / 1000)); // 640
    let micBuf = Buffer.alloc(0);

    browserWS.on('message', (msg) => {
      if (typeof msg === 'string') return;
      if (agentWS.readyState !== WebSocket.OPEN) return;

      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      micBuf = Buffer.concat([micBuf, buf]);
      meterMicBytes += buf.length;

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

    browserWS.on('close', safeClose);
    browserWS.on('error', safeClose);

    function safeClose() {
      if (closed) return;
      closed = true;
      try { agentWS.close(1000); } catch {}
      try { browserWS.terminate?.(); } catch {}
      jlog('info', 'CLIENT→SERVER.close');
    }
  });

  jlog('info', 'ws_path_ready', { route });
}

module.exports = { setupWebDemoLive };
