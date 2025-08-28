// lib/web-demo-live.cjs
const WebSocket = require('ws');
const { makeShadowIntake, updateIntakeFromUserText, intakeSnapshot } =
  require('./shadow-intake.cjs');

function jlog(level, evt, meta = {}) {
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

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on('connection', (browserWS, req) => {
    let closed = false;

    // voiceId from query (?voiceId=1|2|3)
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

    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const dgKey = process.env.DEEPGRAM_API_KEY;

    if (!dgKey) {
      say(browserWS, { type: 'error', error: { message: 'Missing DEEPGRAM_API_KEY' } });
      // Close gracefully so the browser sees 1008 + reason
      try { browserWS.close(1008, 'missing_api_key'); } catch {}
      return;
    }

    const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

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
        jlog('info', 'SERVER→DG.settings_sent', { sttModel, ttsVoice, llmModel, temperature });
        say(browserWS, { type: 'state', state: 'Connected' });
      } catch (e) {
        say(browserWS, { type: 'error', error: { message: 'Failed to send DG Settings' } });
      }
    }

    agentWS.on('open', () => {
      jlog('info', 'SERVER→DG.open', { url: dgUrl });
      sendSettingsOnce();
    });

    // keepalive + simple meters
    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    let meterMicBytes = 0, meterTtsBytes = 0;
    const meter = setInterval(() => {
      if (meterMicBytes || meterTtsBytes) {
        jlog('info', 'web_demo_meter', { mic_bytes_per_s: meterMicBytes, tts_bytes_per_s: meterTtsBytes });
        meterMicBytes = 0; meterTtsBytes = 0;
      }
    }, 1000);

    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s of 20ms frames

    agentWS.on('message', (data) => {
      const isBuf = Buffer.isBuffer(data);
      // JSON control / transcripts
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
            if (preFrames.length) { try { for (const fr of preFrames) agentWS.send(fr); } catch {} preFrames.length = 0; }
            break;
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
            if (text) {
              if (role.includes('user')) updateIntakeFromUserText(intake, text);
              say(browserWS, { type: 'transcript', role: role.includes('agent') ? 'Agent' : 'User', text, partial: !isFinal });
            }
            break;
          case 'AgentWarning':
            jlog('warn', 'DG.warning', { message: evt.message || 'unknown' });
            say(browserWS, { type: 'status', text: `Agent warning: ${evt.message || 'unknown'}` });
            break;
          case 'AgentError':
          case 'Error':
            jlog('error', 'DG.error', { message: evt.description || evt.message || 'unknown' });
            say(browserWS, { type: 'error', error: { message: evt.description || evt.message || 'DG error' } });
            break;
        }
        return;
      }

      // Binary = DG TTS PCM16@16k → Browser
      meterTtsBytes += data.length;
      try { browserWS.send(data, { binary: true }); } catch {}
    });

    agentWS.on('error', (e) => {
      jlog('warn', 'DG.error_event', { err: e?.message || String(e) });
      say(browserWS, { type: 'error', error: { message: `Deepgram error: ${e?.message || 'unknown'}` } });
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive); clearInterval(meter);
      const msg = `Upstream closed (code=${code || 0}, reason="${String(reason || '')}")`;
      jlog('info', 'DG→SERVER.close', { code, reason: String(reason || '') });
      try { jlog('info', 'intake_final', intakeSnapshot(intake)); } catch {}
      // Tell the browser what happened, then close gracefully (1011 => server error)
      say(browserWS, { type: 'status', text: msg });
      try { browserWS.close(1011, 'upstream_closed'); } catch {}
    });

    // Browser mic → DG (16k mono, 20ms frames)
    const FRAME_MS = 20, IN_RATE = 16000, BYTES_PER_SAMPLE = 2;
    const BYTES_PER_FRAME = Math.round(IN_RATE * BYTES_PER_SAMPLE * (FRAME_MS / 1000)); // 640
    let micBuf = Buffer.alloc(0);

    browserWS.on('message', (msg) => {
      if (typeof msg === 'string') return; // ignore control text like {type:'start'}
      if (agentWS.readyState !== WebSocket.OPEN) return;

      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      meterMicBytes += buf.length;
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

    browserWS.on('close', safeClose);
    browserWS.on('error', safeClose);

    function safeClose() {
      if (closed) return;
      closed = true;
      try { agentWS.close(1000); } catch {}
      // NOTE: no terminate() here; we only close the browser side in agentWS.on('close')
    }
  });

  jlog('info', 'web_demo_live_ready', { route });
}

module.exports = { setupWebDemoLive };
