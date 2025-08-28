/* index.cjs – Next + Express + WS + Deepgram Agent + Twilio bridge */
process.env.TZ = 'UTC';
process.on('uncaughtException', (err) => { try { console.error(JSON.stringify({ ts:new Date().toISOString(), level:'error', evt:'process_uncaught_exception', err:err?.message, stack:err?.stack })); } catch {} });
process.on('unhandledRejection', (reason) => { try { console.error(JSON.stringify({ ts:new Date().toISOString(), level:'error', evt:'process_unhandled_rejection', reason:String(reason) })); } catch {} });

const http = require('http');
const express = require('express');
const morgan = require('morgan');
const next = require('next');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const { setupTwilioBridge } = require('./lib/twilio-deepgram-agent-bridge.cjs');
const { sanitizeASCII, compact, makeIntakeState, updateIntakeFromUserText, intakeSnapshot, isComplete } = require('./lib/shadow-intake.cjs');

const PORT = parseInt(process.env.PORT || '10000', 10);
const DEV = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev: DEV, dir: process.cwd() });
const handle = nextApp.getRequestHandler();

/* ---------- JSON logger ---------- */
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
function log(level, evt, meta) {
  if ((LV[level] ?? 2) <= (LV[LOG_LEVEL] ?? 2)) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...(meta || {}) }));
  }
}

/* ---------- Browser bridge helpers (16k linear) ---------- */
function createVoiceBridge({ serverWS, req }) {
  const apiKey = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    log('error', 'DG.missing_api_key', {});
    try { serverWS.send(JSON.stringify({ type: 'error', error: { message: 'Deepgram API key missing on server' } })); } catch {}
    try { serverWS.close(1011, 'missing DG_API_KEY'); } catch {}
    return;
  }

  let sttModel   = (process.env.DG_STT_MODEL || 'nova-2').trim();
  let ttsVoice   = (process.env.DG_TTS_VOICE || 'aura-2-odysseus-en').trim();
  const llmModel = (process.env.LLM_MODEL   || 'gpt-4o-mini').trim();
  const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');

  const firm      = process.env.FIRM_NAME  || 'Benji Personal Injury';
  const agentName = process.env.AGENT_NAME || 'Alexis';
  const DEFAULT_PROMPT =
    `You are ${agentName}, the intake specialist for ${firm}. Ask if the caller is an existing client or in an accident. If existing: ask full name, best phone, and which attorney, then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all and ask if correct; then say you will transfer. Speak briefly and stop when the caller talks.`;
  const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
  const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
  const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
  const prompt = compact(rawPrompt, 380);
  const greeting = sanitizeASCII(
    process.env.AGENT_GREETING ||
    `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
  );

  const dgUrl = (process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse').trim();

  let closed = false, settingsSent = false, settingsApplied = false;
  const preFrames = [];
  const MAX_PRE_FRAMES = 200; // ~4s @20ms

  const intake = makeIntakeState();
  intake.callStartedAt = new Date().toISOString();

  const dgWS = new WebSocket(dgUrl, ['token', apiKey], { perMessageDeflate:false });

  function sendSettings() {
    if (settingsSent) return;
    const settings = {
      type: 'Settings',
      audio: { input: { encoding:'linear16', sample_rate:16000 }, output: { encoding:'linear16', sample_rate:16000 } },
      agent: {
        language:'en', greeting,
        listen:{ provider:{ type:'deepgram', model:sttModel, smart_format:true } },
        think:{ provider:{ type:'open_ai', model:llmModel, temperature }, prompt },
        speak:{ provider:{ type:'deepgram', model:ttsVoice } },
      },
    };
    try {
      dgWS.send(JSON.stringify(settings));
      settingsSent = true;
      log('info','SERVER→DG.settings_sent',{ sttModel, ttsVoice, llmModel, temperature, prompt_len: prompt.length });
      try { serverWS.send(JSON.stringify({ type:'state', state:'Connected' })); } catch {}
    } catch (e) {
      log('error','SERVER→DG.settings_error',{ err:e.message });
      try { serverWS.send(JSON.stringify({ type:'error', error:{ message:'Failed to send Settings to Deepgram' } })); } catch {}
    }
  }

  dgWS.on('open', () => { log('info','SERVER→DG.open',{ url: dgUrl, ip: req.socket.remoteAddress }); sendSettings(); });

  const keepalive = setInterval(() => { if (dgWS.readyState === WebSocket.OPEN) { try { dgWS.send(JSON.stringify({ type:'KeepAlive' })); } catch {} } }, 25_000);

  function maybeParseJsonFrame(data) {
    if (typeof data === 'string') { try { return JSON.parse(data); } catch { return null; } }
    if (Buffer.isBuffer(data)) { if (data.length && data[0] === 0x7b) { try { return JSON.parse(data.toString('utf8')); } catch { return null; } } }
    return null;
  }
  function flushPrerollIfReady() {
    if (!settingsApplied || !preFrames.length) return;
    try { for (const fr of preFrames) dgWS.send(fr); } catch {}
    preFrames.length = 0;
  }

  dgWS.on('message', (data) => {
    const evt = maybeParseJsonFrame(data);
    if (evt) {
      switch (evt.type) {
        case 'Welcome': sendSettings(); break;
        case 'SettingsApplied':
          settingsApplied = true;
          log('info','DG→SERVER.settings_applied');
          try { serverWS.send(JSON.stringify({ type:'state', state:'Listening' })); } catch {}
          flushPrerollIfReady();
          break;
        case 'UserStartedSpeaking':
          try { serverWS.send(JSON.stringify({ type:'state', state:'Listening' })); } catch {}
          break;
        case 'AgentStartedSpeaking':
          try { serverWS.send(JSON.stringify({ type:'state', state:'Speaking' })); } catch {}
          break;
        case 'AgentStoppedSpeaking':
          try { serverWS.send(JSON.stringify({ type:'state', state:'Listening' })); } catch {}
          break;
        case 'Transcript':
        case 'UserTranscript':
        case 'ConversationText':
        case 'History':
        case 'UserResponse':
        case 'AgentTranscript':
        case 'AgentResponse':
        case 'PartialTranscript':
        case 'AddPartialTranscript':
        case 'AddUserMessage':
        case 'AddAssistantMessage': {
          const role = String(evt.role || evt.speaker || evt.actor || '').toLowerCase();
          const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
          const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';
          try { serverWS.send(JSON.stringify({ type:'transcript', payload: evt })); } catch {}
          if (text && role.includes('user') && (isFinal || text.split(/\s+/).length >= 3)) {
            updateIntakeFromUserText(intake, text, (level,e,meta)=>log(level,e,meta));
            if (!intake.completeLogged && isComplete(intake)) {
              intake.completeLogged = true; log('info','intake_complete', intakeSnapshot(intake));
            }
          }
          break;
        }
        case 'Error':
        case 'AgentError': log('warn','DG→SERVER.error',{ evt }); try { serverWS.send(JSON.stringify({ type:'error', error: evt })); } catch {} ; break;
        default: log('debug','DG→SERVER.other',{ type: evt.type });
      }
      return;
    }

    // Binary (TTS linear16@16k) → client
    try { serverWS.send(data, { binary:true }); log('debug','DG→SERVER.audio',{ bytes: data.length }); } catch (e) { log('warn','SERVER→CLIENT.audio_send_err',{ err:e.message }); }
    if (settingsSent && !settingsApplied) { settingsApplied = true; log('warn','DG.settings_assumed_after_audio'); flushPrerollIfReady(); }
  });

  dgWS.on('close', (code, reason) => { clearInterval(keepalive); log('info','DG→SERVER.close',{ code, reason: reason?.toString?.() || '' }); log('info','intake_final', intakeSnapshot(intake)); safeClose(); });
  dgWS.on('error', (e) => { log('warn','DG→SERVER.ws_error',{ err:e?.message || String(e) }); try { serverWS.send(JSON.stringify({ type:'error', error:{ message:e.message } })); } catch {} });

  serverWS.on('message', (data, isBinary) => {
    if (!isBinary && typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'start') {
          const vid = parseInt(String(msg.voiceId || '0'), 10);
          const override = vid && process.env[`VOICE_${vid}_TTS`];
          if (override) ttsVoice = override;
          log('info','CLIENT→SERVER.start',{ voiceId: msg.voiceId || null, ttsVoice });
          if (dgWS.readyState === WebSocket.OPEN && !settingsSent) sendSettings();
        } else if (msg.type === 'stop') {
          log('info','CLIENT→SERVER.stop',{}); safeClose();
        }
      } catch {}
      return;
    }
    if (dgWS.readyState !== WebSocket.OPEN) return;
    if (!settingsApplied) { preFrames.push(Buffer.isBuffer(data)?data:Buffer.from(data)); if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift(); return; }
    try { dgWS.send(data, { binary:true }); } catch (e) { log('warn','SERVER→DG.audio_send_err',{ err:e.message }); }
  });

  serverWS.on('close', (code, reason) => { log('info','CLIENT→SERVER.close',{ code, reason }); safeClose(); });
  serverWS.on('error', (e) => { log('warn','CLIENT→SERVER.ws_error',{ err:e?.message || String(e) }); safeClose(); });

  function safeClose(){ try { dgWS.close(1000); } catch {} try { serverWS.close(1000); } catch {} }
}

/* ---------- boot ---------- */
async function boot() {
  await nextApp.prepare();
  const app = express();
  app.set('trust proxy', 1);
  app.use(morgan('tiny'));

  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.get('/audio-stream', (_req, res) => res.status(426).send('Use WebSocket (wss) to /audio-stream'));

  const server = http.createServer(app);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 125_000;

  const wssEcho   = new WebSocketServer({ noServer: true, perMessageDeflate:false });
  const wssPing   = new WebSocketServer({ noServer: true, perMessageDeflate:false });
  const wssDemo   = new WebSocketServer({ noServer: true, perMessageDeflate:false });
  const wssAudio  = new WebSocketServer({ noServer: true, perMessageDeflate:false });
  const wssTwilio = new WebSocketServer({ noServer: true, perMessageDeflate:false }); // NEW

  // Echo
  wssEcho.on('connection', (ws, req) => { log('info','WS.echo.open',{ ip: req.socket.remoteAddress }); ws.on('message',(d)=>{ try { ws.send(typeof d==='string'?`[echo] ${d}`:d); } catch {} }); });
  // Ping
  wssPing.on('connection', (ws) => { const iv = setInterval(()=>{ try{ ws.send('pong'); }catch{} }, 1000); ws.on('close',()=>clearInterval(iv)); });
  // Demo hello
  wssDemo.on('connection', (ws) => { try { ws.send(JSON.stringify({ hello:'world' })); } catch {} });
  // Browser audio
  function heartbeat(){ this.isAlive = true; }
  wssAudio.on('connection', (ws, req) => {
    log('info','WS.audio.open',{ ip: req.socket.remoteAddress });
    try { ws.send(JSON.stringify({ type:'state', state:'Connected' })); } catch {}
    // @ts-ignore
    ws.isAlive = true; ws.on('pong', heartbeat);
    createVoiceBridge({ serverWS: ws, req });
  });
  const audioHeartbeatInterval = setInterval(() => {
    wssAudio.clients.forEach((ws) => {
      // @ts-ignore
      if (ws.isAlive === false) return ws.terminate();
      // @ts-ignore
      ws.isAlive = false; try { ws.ping(); } catch {}
    });
  }, 30_000);
  process.on('SIGTERM',()=>clearInterval(audioHeartbeatInterval));
  process.on('SIGINT', ()=>clearInterval(audioHeartbeatInterval));

  // Twilio <-> Deepgram bridge
  setupTwilioBridge(wssTwilio, { log });

  // Upgrade routing
  server.on('upgrade', (req, socket, head) => {
    const hdrUp = String(req.headers['upgrade'] || '').toLowerCase();
    if (hdrUp !== 'websocket') { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    let pathname = '/'; try { const u = new URL(req.url, `http://${req.headers.host||'localhost'}`); pathname = u.pathname; } catch {}
    log('info','WS.upgrade',{ path: pathname, ua: req.headers['user-agent'] });

    if (pathname === '/ws-echo')      wssEcho.handleUpgrade(req, socket, head, (ws)=>wssEcho.emit('connection', ws, req));
    else if (pathname === '/ws-ping') wssPing.handleUpgrade(req, socket, head, (ws)=>wssPing.emit('connection', ws, req));
    else if (pathname === '/web-demo/ws') wssDemo.handleUpgrade(req, socket, head, (ws)=>wssDemo.emit('connection', ws, req));
    else if (pathname === '/audio-stream') wssAudio.handleUpgrade(req, socket, head, (ws)=>wssAudio.emit('connection', ws, req));
    else if (pathname === '/twilio-bidi')  wssTwilio.handleUpgrade(req, socket, head, (ws)=>wssTwilio.emit('connection', ws, req)); // NEW
    else { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });

  // Next last
  app.use((req, res) => handle(req, res));
  server.listen(PORT, () => log('info','server_listen',{ port: PORT, dev: DEV }));
}
boot().catch((e)=>{ console.error(e); process.exit(1); });
