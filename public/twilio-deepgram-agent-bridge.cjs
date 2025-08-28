// lib/twilio-deepgram-agent-bridge.cjs
const WebSocket = require('ws');
const crypto = require('crypto');
const {
  sanitizeASCII, compact,
  makeIntakeState, updateIntakeFromUserText, intakeSnapshot, isComplete,
} = require('./shadow-intake.cjs');

/** Pass your logger in so logs unify with index.cjs */
function setupTwilioBridge(wss, { log }) {
  const LV = { error:0, warn:1, info:2, debug:3 };
  const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const logger = (level, evt, meta) => {
    if ((LV[level] ?? 2) <= (LV[LOG_LEVEL] ?? 2)) {
      log(level, evt, meta);
    }
  };

  const BARGE_ENABLE      = String(process.env.BARGE_ENABLE ?? 'true').toLowerCase() !== 'false';
  const BARGE_MUTE_MS     = parseInt(process.env.BARGE_MUTE_MS || '400', 10);
  const CLEAR_THROTTLE_MS = parseInt(process.env.CLEAR_THROTTLE_MS || '600', 10);

  const PREBUF_MAX_CHUNKS = parseInt(process.env.PREBUF_MAX_CHUNKS || '6', 10); // pre-roll while settings apply
  const TWILIO_FRAME_BYTES = 160; // 20ms @ 8k μ-law
  const BUFFER_FRAMES      = parseInt(process.env.BUFFER_FRAMES || '4', 10); // ~80ms per send to DG
  const SEND_BYTES         = TWILIO_FRAME_BYTES * BUFFER_FRAMES;

  wss.on('connection', (twilioWS, req) => {
    logger('info','twilio_ws_open', { ip: req.socket.remoteAddress });

    const apiKey = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      logger('error', 'DG.missing_api_key', {});
      try { twilioWS.close(1011, 'missing DG_API_KEY'); } catch {}
      return;
    }

    // Configure Agent (mulaw 8k in/out)
    const sttModel   = (process.env.DG_STT_MODEL || 'nova-2').trim();
    const ttsVoice   = (process.env.DG_TTS_VOICE || 'aura-2-odysseus-en').trim();
    const llmModel   = (process.env.LLM_MODEL   || 'gpt-4o-mini').trim();
    const temperature= Number(process.env.LLM_TEMPERATURE || '0.15');
    const firm       = process.env.FIRM_NAME  || 'Benji Personal Injury';
    const agentName  = process.env.AGENT_NAME || 'Alexis';
    const DEFAULT_PROMPT =
      `You are ${agentName}, the intake specialist for ${firm}. Ask if the caller is an existing client or in an accident. If existing: ask full name, best phone, and which attorney, then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Speak briefly and stop when the caller talks.`;
    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
    const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
    const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
    const prompt    = compact(rawPrompt, 380);
    const greeting  = sanitizeASCII(process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`);

    const dgUrl = (process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse').trim();
    const agentWS = new WebSocket(dgUrl, ['token', apiKey], { perMessageDeflate: false });
    let settingsSent = false, settingsApplied = false;

    const intake = makeIntakeState();
    intake.callStartedAt = new Date().toISOString();

    let streamSid = null;
    let inBuffer = Buffer.alloc(0);
    const preRoll = [];

    let bargeMuteUntil = 0;
    let lastClearAt = 0;
    const canClearNow = () => {
      const now = Date.now();
      if (now - lastClearAt < CLEAR_THROTTLE_MS) return false;
      lastClearAt = now; return true;
    };
    const requestClear = (reason) => {
      if (!streamSid || !canClearNow()) return;
      try { twilioWS.send(JSON.stringify({ event: 'clear', streamSid })); } catch {}
      logger('info','twilio_clear', { reason });
    };

    const sendSettings = () => {
      if (settingsSent) return;
      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'mulaw', sample_rate: 8000 },
          output: { encoding: 'mulaw', sample_rate: 8000, container: 'none' },
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
        logger('info','SERVER→DG.settings_sent', { sttModel, ttsVoice, llmModel, temperature, prompt_len: prompt.length });
      } catch (e) {
        logger('error','SERVER→DG.settings_err', { err: e.message });
      }
    };

    agentWS.on('open', () => {
      logger('info','SERVER→DG.open', { url: dgUrl });
      sendSettings();
    });

    // keepalive
    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25_000);

    agentWS.on('message', (data) => {
      // Try JSON first
      let evt = null;
      if (typeof data === 'string') { try { evt = JSON.parse(data); } catch {} }
      else if (Buffer.isBuffer(data) && data.length && data[0] === 0x7b) { try { evt = JSON.parse(data.toString('utf8')); } catch {} }

      if (evt) {
        switch (evt.type) {
          case 'Welcome': sendSettings(); break;
          case 'SettingsApplied':
            settingsApplied = true;
            logger('info','DG→SERVER.settings_applied');
            if (preRoll.length) {
              try { for (const c of preRoll) agentWS.send(c); } catch {}
              preRoll.length = 0;
            }
            break;

          case 'UserStartedSpeaking':
            if (BARGE_ENABLE) {
              requestClear('user_started_speaking');
              bargeMuteUntil = Date.now() + BARGE_MUTE_MS;
            }
            break;

          case 'AgentStartedSpeaking':
            // can mask or do nothing; Twilio playback will continue
            break;

          // Transcripts / text-ish
          case 'ConversationText':
          case 'History':
          case 'UserTranscript':
          case 'UserResponse':
          case 'Transcript':
          case 'PartialTranscript':
          case 'AddUserMessage':
          case 'AddAssistantMessage': {
            const role = String(evt.role || evt.speaker || evt.actor || '').toLowerCase();
            const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
            const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';
            if (text && role.includes('user') && (isFinal || text.split(/\s+/).length >= 3)) {
              updateIntakeFromUserText(intake, text, (level, e, meta) => logger(level, e, meta));
              if (!intake.completeLogged && isComplete(intake)) {
                intake.completeLogged = true;
                logger('info', 'intake_complete', intakeSnapshot(intake));
              }
            }
            break;
          }

          case 'Error':
          case 'AgentError':
            logger('warn','DG→SERVER.error', { evt });
            break;
        }
        return;
      }

      // Binary = DG TTS μ-law → Twilio media
      if (!streamSid) return;
      if (Date.now() < bargeMuteUntil) return; // barge-mute window
      const payload = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
      try {
        twilioWS.send(JSON.stringify({ event:'media', streamSid, media:{ payload } }));
        twilioWS.send(JSON.stringify({ event:'mark',  streamSid, mark:{ name: crypto.randomUUID() } }));
      } catch (e) {
        logger('warn','twilio_media_send_err', { err: e.message });
      }
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive);
      logger('info','DG→SERVER.close', { code, reason: reason?.toString?.() || '' });
      logger('info','intake_final', intakeSnapshot(intake));
      safeClose();
    });
    agentWS.on('error', (e) => logger('warn','DG→SERVER.ws_error', { err: e?.message || String(e) }));

    // Twilio → DG
    twilioWS.on('message', (raw) => {
      let msg = null; try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.event) {
        case 'start':
          streamSid = msg.start?.streamSid;
          logger('info','twilio_start', { streamSid, tracks: msg.start?.tracks });
          break;
        case 'media': {
          if (msg.media?.track && msg.media.track !== 'inbound') break;
          const b = Buffer.from(msg.media.payload, 'base64');
          inBuffer = Buffer.concat([inBuffer, b]);
          while (inBuffer.length >= SEND_BYTES) {
            const chunk = inBuffer.subarray(0, SEND_BYTES);
            inBuffer = inBuffer.subarray(SEND_BYTES);
            if (agentWS.readyState === WebSocket.OPEN) {
              if (settingsSent && settingsApplied) {
                try { agentWS.send(chunk); } catch (e) { logger('warn','dg_audio_send_err', { err: e.message }); }
              } else if (settingsSent) {
                preRoll.push(chunk);
                if (preRoll.length > PREBUF_MAX_CHUNKS) preRoll.shift();
              }
            }
          }
          break;
        }
        case 'stop':
          safeClose();
          break;
      }
    });

    twilioWS.on('close', safeClose);
    twilioWS.on('error', (e) => logger('warn','twilio_ws_error', { err: e?.message || String(e) }));

    function safeClose() {
      try { agentWS.close(1000); } catch {}
      try { twilioWS.close(1000); } catch {}
    }
  });
}

module.exports = { setupTwilioBridge };
