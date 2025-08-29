// lib/web-demo-live.cjs
// Browser mic <-> Deepgram Agent bridge (no Twilio).
// - Sends Settings (STT/LLM/TTS, greeting, prompt)
// - Pumps 20ms silence to DG after SettingsApplied until greeting TTS finishes
// - Gates mic->DG until greeting ends (prevents echo/barge-in unless enabled)
// - Streams DG TTS (PCM16@16k) back to browser
// - Very verbose structured logging for root-cause analysis

const WebSocket = require("ws");
const { URL } = require("url");

// ------------------------ constants & helpers ------------------------

const FRAME_MS = 20;                 // 20 ms frames
const IN_RATE = 16000;               // Deepgram input rate
const BPS = 2;                       // 16-bit PCM
const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS / 1000)); // 640
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME);                    // zeros

function jlog(level, evt, extra = {}) {
  // unified, machine-parsable logs
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...extra }));
}

function sanitizeASCII(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactPrompt(s, max = 380) {
  if (!s) return "";
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return "You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.";
}

function resolveVoiceById(voiceId) {
  // VOICE_1_TTS / VOICE_2_TTS / VOICE_3_TTS -> fallback DG_TTS_VOICE
  const envKey = `VOICE_${voiceId}_TTS`;
  return (
    process.env[envKey] ||
    process.env.DG_TTS_VOICE ||
    "aura-2-odysseus-en"
  );
}

// ------------------------ main bridge ------------------------

function setupWebDemoLive(server, { route = "/audio-stream" } = {}) {
  const wss = new WebSocket.Server({
    server,
    path: route,
    perMessageDeflate: false,
  });

  jlog("info", "web_demo_live_ready", { route });

  wss.on("connection", (browserWS, req) => {
    // ---- per-connection state
    const connId = Math.random().toString(36).slice(2, 9);
    jlog("info", "CLIENT→SERVER.open", {
      route,
      connId,
      ua: req.headers["user-agent"],
    });

    let closed = false;
    let voiceId = 2; // default
    let allowMicToDG = false;     // gate mic until greeting is finished
    let speaking = false;          // updated when DG TTS is flowing
    let lastTtsAt = 0;

    let settingsSent = false;
    let settingsApplied = false;

    // metering
    let framesFromClient = 0;
    let framesToDG = 0;
    let micBytes = 0;
    let ttsBytes = 0;

    // keepalive & timers
    let keepalive = null;
    let meter = null;
    let stateTimer = null;
    let silenceTimer = null;

    // preroll frames (until DG applies settings)
    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s

    // mic framing
    let micBuf = Buffer.alloc(0);

    // ---- Build Deepgram Settings (prompt, greeting, providers)
    const firm      = process.env.FIRM_NAME  || "Benji Personal Injury";
    const agentName = process.env.AGENT_NAME || "Alexis";

    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || "false").toLowerCase() !== "true";
    const rawPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || DEFAULT_PROMPT) : DEFAULT_PROMPT;
    const prompt    = compactPrompt(sanitizeASCII(rawPrompt), 380);

    const greeting  = sanitizeASCII(
      process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
    );

    const sttModel  = (process.env.DG_STT_MODEL || "nova-2").trim();
    const llmModel  = (process.env.LLM_MODEL   || "gpt-4o-mini").trim();
    const temperature = Number(process.env.LLM_TEMPERATURE || "0.15");

    // ---- Deepgram Agent connection
    const DG_URL = process.env.DG_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
    const DG_KEY = process.env.DEEPGRAM_API_KEY;

    if (!DG_KEY) {
      jlog("error", "DG.missing_api_key", { connId });
      try { browserWS.send(JSON.stringify({ type: "error", error: { message: "Missing DEEPGRAM_API_KEY" } })); } catch {}
      safeClose();
      return;
    }

    const agentWS = new WebSocket(DG_URL, ["token", DG_KEY]);

    jlog("info", "DG.handshake_try", { url: DG_URL });

    // ---- util: (de)activate silence pump
    function startSilencePump() {
      if (silenceTimer) return;
      jlog("info", "silence.start", { connId });
      silenceTimer = setInterval(() => {
        if (agentWS.readyState === WebSocket.OPEN) {
          try { agentWS.send(SILENCE_FRAME); framesToDG++; } catch {}
        }
      }, FRAME_MS);
    }

    function stopSilencePump() {
      if (!silenceTimer) return;
      clearInterval(silenceTimer);
      silenceTimer = null;
      jlog("info", "silence.stop", { connId });
    }

    // ---- send Settings to DG
    function sendSettings() {
      if (settingsSent) return;
      const ttsVoice = resolveVoiceById(voiceId);
      const settings = {
        type: "Settings",
        audio: {
          input:  { encoding: "linear16", sample_rate: IN_RATE },
          output: { encoding: "linear16", sample_rate: IN_RATE },
        },
        agent: {
          language: "en",
          greeting,
          listen: { provider: { type: "deepgram", model: sttModel, smart_format: true } },
          think:  { provider: { type: "open_ai",  model: llmModel, temperature } },
          speak:  { provider: { type: "deepgram", model: ttsVoice } },
        },
      };
      try {
        agentWS.send(JSON.stringify(settings));
        settingsSent = true;
        jlog("info", "SERVER→DG.settings_sent", {
          connId, sttModel, ttsVoice, llmModel, temperature
        });
        try {
          browserWS.send(JSON.stringify({
            type: "settings",
            sttModel, ttsVoice, llmModel, temperature,
            greeting, prompt_len: prompt.length
          }));
        } catch {}
      } catch (e) {
        jlog("error", "SERVER→DG.settings_failed", { connId, err: String(e) });
      }
    }

    // ---- DG events
    agentWS.on("open", () => {
      jlog("info", "SERVER→DG.open", { connId, url: DG_URL });
      // Prompt is enforced via system message:
      try {
        agentWS.send(JSON.stringify({ type: "SystemMessage", text: prompt }));
      } catch {}
      sendSettings();

      // keepalive every 25s
      keepalive = setInterval(() => {
        if (agentWS.readyState === WebSocket.OPEN) {
          try { agentWS.send(JSON.stringify({ type: "KeepAlive" })); } catch {}
        }
      }, 25000);
    });

    agentWS.on("message", (data) => {
      const isBuf = Buffer.isBuffer(data);
      // Binary = DG TTS (PCM16@16k) -> forward to browser + mark speaking
      if (isBuf && data.length && data[0] !== 0x7b) {
        ttsBytes += data.length;
        speaking = true;
        lastTtsAt = Date.now();
        try { browserWS.send(data, { binary: true }); } catch {}
        return;
      }

      // JSON control / transcripts
      let evt = null;
      try { evt = JSON.parse(isBuf ? data.toString("utf8") : data); } catch {}
      if (!evt) return;

      switch (evt.type) {
        case "Welcome":
          // some DG installations want Settings after Welcome; we already sent, but safe:
          sendSettings();
          break;

        case "SettingsApplied":
          settingsApplied = true;
          jlog("info", "DG.settings_applied", { connId });
          // keep DG alive while greeting plays
          allowMicToDG = false;      // gate mic
          startSilencePump();
          // flush any preframes? we keep them dropped until greeting ends to avoid echo
          break;

        // transcript-ish
        case "ConversationText":
        case "History":
        case "UserTranscript":
        case "UserResponse":
        case "Transcript":
        case "AddUserMessage":
        case "AddAssistantMessage":
        case "AgentTranscript":
        case "AgentResponse":
        case "PartialTranscript":
        case "AddPartialTranscript": {
          const role = String((evt.role || evt.speaker || evt.actor || "")).toLowerCase();
          const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? "").trim();
          const partial = !(evt.final === true || evt.is_final === true || evt.status === "final" || evt.type === "UserResponse");
          if (text) {
            try {
              browserWS.send(JSON.stringify({
                type: "transcript",
                role: role.includes("agent") || role.includes("assistant") ? "Agent" : "User",
                text, partial
              }));
            } catch {}
          }
          break;
        }

        case "AgentWarning":
          jlog("warn", "DG.warning", { connId, message: evt.message || "unknown" });
          try { browserWS.send(JSON.stringify({ type: "status", text: `Agent warning: ${evt.message || "unknown"}` })); } catch {}
          break;

        case "AgentError":
        case "Error":
          jlog("error", "DG.error", { connId, message: evt.description || evt.message || "unknown" });
          try { browserWS.send(JSON.stringify({ type: "status", text: `Agent error: ${evt.description || evt.message || "unknown"}` })); } catch {}
          break;
      }
    });

    agentWS.on("close", (code, reason) => {
      jlog("info", "DG→SERVER.close", { connId, code, reason: String(reason || "") });
      safeClose();
    });

    agentWS.on("error", (e) => {
      jlog("warn", "DG.error_event", { err: String(e?.message || e) });
    });

    // ---- greeting-finish detector & UI state pusher
    stateTimer = setInterval(() => {
      const now = Date.now();
      const speakingNow = lastTtsAt && (now - lastTtsAt) < 300;
      if (speaking !== speakingNow) {
        speaking = speakingNow;
        const state = speaking ? "Speaking" : "Listening";
        jlog("info", `state.${speaking ? "speaking" : "listening"}`, { connId });
        try { browserWS.send(JSON.stringify({ type: "state", state })); } catch {}
        if (!speaking) {
          // Greeting done → stop silence and allow mic through
          stopSilencePump();
          allowMicToDG = true;
        }
      }
    }, 100);

    // ---- throughput meter
    meter = setInterval(() => {
      if (micBytes || ttsBytes || framesFromClient || framesToDG) {
        jlog("info", "throughput", {
          connId,
          mic_bytes_per_s: micBytes,
          tts_bytes_per_s: ttsBytes,
          frames_from_client_per_s: framesFromClient,
          frames_to_dg_per_s: framesToDG
        });
        micBytes = 0; ttsBytes = 0; framesFromClient = 0; framesToDG = 0;
      }
    }, 1000);

    // ---- Browser → Server messages
    browserWS.on("message", (msg) => {
      if (typeof msg === "string") {
        // client sends a 'start' envelope with selected voiceId
        try {
          const m = JSON.parse(msg);
          if (m && m.type === "start") {
            const v = parseInt(String(m.voiceId || "2"), 10);
            if ([1, 2, 3].includes(v)) voiceId = v;
            jlog("info", "CLIENT.start", { connId, voiceId });
            // If we haven't sent settings yet, resend with chosen voice
            if (!settingsSent) sendSettings();
          }
        } catch {}
        return;
      }

      // Binary PCM16@16k from browser (20ms frames emitted by worklet)
      if (agentWS.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      micBytes += buf.length;

      // accumulate until we have whole frames
      micBuf = Buffer.concat([micBuf, buf]);
      while (micBuf.length >= BYTES_PER_FRAME) {
        const frame = micBuf.subarray(0, BYTES_PER_FRAME);
        micBuf = micBuf.subarray(BYTES_PER_FRAME);
        framesFromClient++;

        if (!settingsSent || !settingsApplied) {
          // hold mic before DG is ready; we use silence pump to keep DG alive
          preFrames.push(frame);
          if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
        } else if (allowMicToDG) {
          try { agentWS.send(frame); framesToDG++; } catch {}
        } else {
          // still greeting → drop (or you could keep a tiny rolling buffer if desired)
        }
      }
    });

    browserWS.on("close", (code, reason) => {
      jlog("info", "CLIENT→SERVER.close", { connId, code, reason });
      safeClose();
    });

    browserWS.on("error", (e) => {
      jlog("warn", "CLIENT→SERVER.error", { connId, err: String(e?.message || e) });
      safeClose();
    });

    function safeClose() {
      if (closed) return;
      closed = true;

      try { clearInterval(keepalive); } catch {}
      try { clearInterval(meter); } catch {}
      try { clearInterval(stateTimer); } catch {}
      stopSilencePump();

      try { agentWS.close(1000); } catch {}
      try { browserWS.terminate?.(); } catch {}

      // Final intake snapshot hook (placeholder to keep parity with old logs)
      const intake = {
        sessionStartedAt: new Date().toISOString(),
        kind: null, name: null, phone: null, email: null,
        happened: null, when: null, city: null, state: null,
        notes: [], notesCount: 0
      };
      jlog("info", "intake_final", intake);
    }
  });
}

module.exports = { setupWebDemoLive };
