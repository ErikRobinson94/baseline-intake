// lib/web-demo-live.cjs
// Browser mic <-> Deepgram Agent bridge (no Twilio).
// Streams PCM16@16k (20 ms frames) to DG Converse Agent;
// forwards TTS (PCM16@16k) back to the browser; forwards transcripts & states;
// integrates shadow-intake extraction.

const WebSocket = require('ws');

// NOTE: your shadow-intake.cjs is at repo root, not under /lib
const { makeShadowIntake, updateIntakeFromUserText, intakeSnapshot } =
  require('../shadow-intake.cjs');

function jlog(level, evt, meta = {}) {
  const rec = { ts: new Date().toISOString(), level, evt, ...meta };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`[${level}] ${evt}`, meta); }
}

// tiny helpers
function sanitizeASCII(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

    // read ?voiceId=1|2|3 (defaults to 1)
    let voiceId = 1;
    try {
      const u = new URL(req.url, 'http://local');
      const v = parseInt(u.searchParams.get('voiceId') || '1', 10);
      if ([1, 2, 3].includes(v)) voiceId = v;
    } catch {}

    // per-avatar TTS mapping
    const ttsVoice =
      process.env[`VOICE_${voiceId}_TTS`] ||
      process.env.DG_TTS_VOICE ||
      'aura-2-odysseus-en';

    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      try { browserWS.send(JSON.stringify({ type: 'error', error: { message: 'Missing DEEPGRAM_API_KEY' } })); } catch {}
      browserWS.close(1008, 'missing_api_key'); // policy violation
      return;
    }

    // Create DG Agent WS (Converse)
    const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

    // models & prompt/greeting (parity with phone bridge)
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

    // shadow intake per session
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
        // tell UI what we applied
        try { browserWS.send(JSON.stringify({ type: 'state', state: 'Connected' })); } catch {}
      } catch (e) {
        try { browserWS.send(JSON.stringify({ type: 'error', error: { message: 'Failed to send DG Settings' } })); } catch {}
      }
    }

    agentWS.on('open', () => {
      jlog('info', 'SERVER→DG.open', { url: dgUrl, ip: browserWS?._socket?.remoteAddress });
      sendSettingsOnce();
    });

    // keepalive
    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    // simple meters
    let meterMicBytes = 0, meterTtsBytes = 0;
    const meter = setInterval(() => {
      if (meterMicBytes || meterTtsBytes) {
        jlog('info', 'web_demo_meter', { mic_bytes_per_s: meterMicBytes, tts_bytes_per_s: meterTtsBytes });
        meterMicBytes = 0; meterTtsBytes = 0;
      }
    }, 1000);

    // preroll (frames queued before SettingsApplied)
    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s

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
          case 'Welcome':
            sendSettingsOnce();
            break;

          case 'SettingsApplied':
            settingsApplied = true;
            if (preFrames.length) {
              try { for (const fr of preFrames) agentWS.send(fr); } catch {}
              preFrames.length = 0;
            }
            break;

          // catch broad transcript events
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
            // update shadow intake on user text
            if (role.includes('user')) {
              updateIntakeFromUserText(intake, text);
            }
            try {
              browserWS.send(JSON.stringify({
                type: 'transcript',
                role: role.includes('agent') ? 'Agent' : 'User',
                text,
                partial: !isFinal
              }));
            } catch {}
            break;

          case 'AgentWarning':
            jlog('warn', 'DG.warning', { message: evt.message || 'unknown' });
            break;

          case 'AgentError':
          case 'Error':
            jlog('error', 'DG.error', { message: evt.description || evt.message || 'unknown' });
            try { browserWS.send(JSON.stringify({ type: 'error', error: { message: evt.description || evt.message || 'DG error' } })); } catch {}
            break;
        }
        return;
      }

      // Binary => DG TTS PCM16@16k → browser as-is (your client resamples to ctx rate)
      meterTtsBytes += data.length;
      try { browserWS.send(data, { binary: true }); } catch {}
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive); clearInterval(meter);
      jlog('info', 'DG→SERVER.close', { code, reason: String(reason || '') });
      // final intake snapshot
      try { jlog('info', 'intake_final', intakeSnapshot(intake)); } catch {}
      safeClose();
    });

    agentWS.on('error', (e) => jlog('warn', 'DG.error_event', { err: e?.message || String(e) }));

    // Browser mic → DG, 20 ms framing, queue until ready
    const FRAME_MS = 20, IN_RATE = 16000, BYTES_PER_SAMPLE = 2;
    const BYTES_PER_FRAME = Math.round(IN_RATE * BYTES_PER_SAMPLE * (FRAME_MS / 1000)); // 640
    let micBuf = Buffer.alloc(0);

    browserWS.on('message', (msg) => {
      // Ignore text (e.g., {type:'start'})
      if (typeof msg === 'string') return;
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
      try { browserWS.terminate?.(); } catch {}
    }
  });

  jlog('info', 'web_demo_live_ready', { route });
}

module.exports = { setupWebDemoLive };
